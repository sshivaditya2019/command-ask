import { Context } from "../types";
import { CompletionsType } from "../adapters/openai/helpers/completions";
import { CommentSimilaritySearchResult } from "../adapters/supabase/helpers/comment";
import { IssueSimilaritySearchResult } from "../adapters/supabase/helpers/issues";
import { recursivelyFetchLinkedIssues } from "../helpers/issue-fetching";
import { formatChatHistory } from "../helpers/format-chat-history";
import { fetchRepoDependencies, fetchRepoLanguageStats } from "./ground-truths/chat-bot";
import { findGroundTruths } from "./ground-truths/find-ground-truths";
import { bubbleUpErrorComment, logger } from "../helpers/errors";

export async function askQuestion(context: Context, question: string) {
  if (!question) {
    throw logger.error("No question provided");
  }
  // using any links in comments or issue/pr bodies to fetch more context
  const { specAndBodies, streamlinedComments } = await recursivelyFetchLinkedIssues({
    context,
    maxDepth: 2,
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    issueNum: context.payload.issue.number,
  });
  // build a nicely structure system message containing a streamlined chat history
  // includes the current issue, any linked issues, and any linked PRs
  const formattedChat = await formatChatHistory(context, streamlinedComments, specAndBodies, 2);
  logger.info("Formatted chat history" + formattedChat.join("\n"));
  return await askLlm(context, question, formattedChat);
}

export async function askLlm(context: Context, question: string, formattedChat: string[]): Promise<CompletionsType> {
  const {
    env: { UBIQUITY_OS_APP_NAME },
    config: { model, similarityThreshold, maxTokens },
    adapters: {
      supabase: { comment, issue },
      voyage: { reranker },
      openai: { completions },
    },
  } = context;

  context.logger.info("Asking LLM question: " + question);
  try {
    // using db functions to find similar comments and issues
    const [similarComments, similarIssues] = await Promise.all([
      comment.findSimilarComments(question, 1 - similarityThreshold, ""),
      issue.findSimilarIssues(question, 1 - similarityThreshold, ""),
    ]);

    // combine the similar comments and issues into a single array
    const similarText = [
      ...(similarComments?.map((comment: CommentSimilaritySearchResult) => comment.comment_plaintext) || []),
      ...(similarIssues?.map((issue: IssueSimilaritySearchResult) => issue.issue_plaintext) || []),
    ];

    context.logger.info("Similar text: " + similarText.join("\n"));

    // filter out any empty strings
    formattedChat = formattedChat.filter((text) => text);

    // rerank the similar text using voyageai
    const rerankedText = similarText.length > 0 ? await reranker.reRankResults(similarText, question) : [];
    // gather structural data about the payload repository
    const [languages, { dependencies, devDependencies }] = await Promise.all([fetchRepoLanguageStats(context), fetchRepoDependencies(context)]);

    context.logger.info("Languages: " + languages.join(", "));
    let groundTruths: string[] = [];

    if (!languages.length) {
      groundTruths.push("No languages found in the repository");
    }

    if (!Reflect.ownKeys(dependencies).length) {
      groundTruths.push("No dependencies found in the repository");
    }

    if (!Reflect.ownKeys(devDependencies).length) {
      groundTruths.push("No devDependencies found in the repository");
    }

    if (groundTruths.length === 3) {
      return await completions.createCompletion(question, model, rerankedText, formattedChat, groundTruths, UBIQUITY_OS_APP_NAME, maxTokens);
    }

    groundTruths = await findGroundTruths(context, "chat-bot", { languages, dependencies, devDependencies });
    return await completions.createCompletion(question, model, rerankedText, formattedChat, groundTruths, UBIQUITY_OS_APP_NAME, maxTokens);
  } catch (error) {
    throw bubbleUpErrorComment(context, error, false);
  }
}
