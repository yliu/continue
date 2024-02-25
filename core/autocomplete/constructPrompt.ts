import Parser from "web-tree-sitter";
import { FileWithContents, TabAutocompleteOptions } from "..";
import { RangeInFileWithContents } from "../commands/util";
import {
  countTokens,
  pruneLinesFromBottom,
  pruneLinesFromTop,
} from "../llm/countTokens";
import { getBasename } from "../util";

import { getAst, getScopeAroundRange, getTreePathAtCursor } from "./ast";
import { AutocompleteLanguageInfo, LANGUAGES, Typescript } from "./languages";
import { rankSnippets } from "./ranking";
import { slidingWindowMatcher } from "./slidingWindow";

export function languageForFilepath(
  filepath: string
): AutocompleteLanguageInfo {
  return LANGUAGES[filepath.split(".").slice(-1)[0]] || Typescript;
}

function formatExternalSnippet(
  filepath: string,
  snippet: string,
  language: AutocompleteLanguageInfo
) {
  const comment = language.comment;
  const lines = [
    comment + " Path: " + getBasename(filepath),
    ...snippet.split("\n").map((line) => comment + " " + line),
    comment,
  ];
  return lines.join("\n");
}

const BLOCK_TYPES = ["body", "statement_block"];

function shouldCompleteMultiline(
  treePath: Parser.SyntaxNode[],
  cursorLine: number
): boolean {
  // If at the base of the file, do multiline
  if (treePath.length === 1) {
    return true;
  }

  // If at the first line of an otherwise empty funtion body, do multiline
  for (let i = treePath.length - 1; i >= 0; i--) {
    const node = treePath[i];
    if (
      BLOCK_TYPES.includes(node.type) &&
      Math.abs(node.startPosition.row - cursorLine) <= 1
    ) {
      let text = node.text;
      text = text.slice(text.indexOf("{") + 1);
      text = text.slice(0, text.lastIndexOf("}"));
      text = text.trim();
      return text.split("\n").length === 1;
    }
  }

  return false;
}

export async function constructAutocompletePrompt(
  filepath: string,
  fullPrefix: string,
  fullSuffix: string,
  clipboardText: string,
  language: AutocompleteLanguageInfo,
  getDefinition: (
    filepath: string,
    line: number,
    character: number
  ) => Promise<FileWithContents | undefined>,
  options: TabAutocompleteOptions,
  recentlyEditedRanges: RangeInFileWithContents[],
  recentlyEditedDocuments: FileWithContents[]
): Promise<{
  prefix: string;
  suffix: string;
  useFim: boolean;
  completeMultiline: boolean;
}> {
  // Find external snippets
  let snippets: FileWithContents[] = [];

  const windowAroundCursor =
    fullPrefix.slice(
      -options.slidingWindowSize * options.slidingWindowPrefixPercentage
    ) +
    fullSuffix.slice(
      options.slidingWindowSize * (1 - options.slidingWindowPrefixPercentage)
    );

  const slidingWindowMatches = await slidingWindowMatcher(
    recentlyEditedDocuments,
    windowAroundCursor,
    3,
    options.slidingWindowSize
  );
  snippets.push(...slidingWindowMatches);

  const recentlyEdited = await Promise.all(
    recentlyEditedRanges
      .map(async (r) => {
        const scope = await getScopeAroundRange(r);
        if (!scope) return null;

        return {
          filepath: r.filepath,
          contents: r.contents,
        };
      })
      .filter((s) => !!s)
  );
  snippets.push(...(recentlyEdited as any));

  let treePath: Parser.SyntaxNode[] | undefined;
  try {
    const ast = await getAst(filepath, fullPrefix + fullSuffix);
    if (!ast) {
      throw new Error(`AST undefined for ${filepath}`);
    }

    treePath = await getTreePathAtCursor(ast, fullPrefix.length);
  } catch (e) {
    console.error("Failed to parse AST", e);
  }

  let completeMultiline = false;
  if (treePath) {
    // Get function def when inside call expression
    let callExpression = undefined;
    for (let node of treePath.reverse()) {
      if (node.type === "call_expression") {
        callExpression = node;
        break;
      }
    }
    if (callExpression) {
      const definition = await getDefinition(
        filepath,
        callExpression.startPosition.row,
        callExpression.startPosition.column
      );
      if (definition) {
        snippets.push(definition);
      }
    }

    // Use AST to determine whether to complete multiline
    let cursorLine = fullPrefix.split("\n").length - 1;
    completeMultiline = shouldCompleteMultiline(treePath, cursorLine);
  }

  // Rank / order the snippets
  snippets = rankSnippets(snippets, windowAroundCursor);

  // How to add snippets to the prefix? Count separately? Always keep some of the prefix??

  // Construct basic prefix / suffix
  const formattedSnippets = snippets
    .map((snippet) =>
      formatExternalSnippet(snippet.filepath, snippet.contents, language)
    )
    .join("\n");
  const maxPrefixTokens =
    options.maxPromptTokens * options.prefixPercentage -
    countTokens(formattedSnippets, "gpt-4");
  let prefix = pruneLinesFromTop(fullPrefix, maxPrefixTokens);
  if (formattedSnippets.length > 0) {
    prefix = formattedSnippets + "\n" + prefix;
  }

  const maxSuffixTokens = Math.min(
    options.maxPromptTokens - countTokens(prefix, "gpt-4"),
    options.maxSuffixPercentage * options.maxPromptTokens
  );
  let suffix = pruneLinesFromBottom(fullSuffix, maxSuffixTokens);

  return { prefix, suffix, useFim: true, completeMultiline };
}
