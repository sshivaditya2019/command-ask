import { createKey } from "../handlers/comments";
import { FetchParams, User } from "../types/github-types";
import { StreamlinedComment, TokenLimits } from "../types/llm";
import {
  idIssueFromComment,
  mergeStreamlinedComments,
  splitKey,
  fetchSimilarIssues,
  fetchCodeLinkedFromIssue,
  pullReadmeFromRepoForIssue,
  fetchLinkedIssuesFromComment,
} from "./issue";
import { fetchLinkedIssues, fetchIssue, mergeCommentsAndFetchSpec } from "./issue-fetching";
import { encode } from "gpt-tokenizer";

function createStreamlinedComment(params: {
  id: string | number;
  body: string;
  user: Partial<User> | null | string;
  org: string;
  repo: string;
  issueUrl: string;
}): StreamlinedComment {
  return {
    id: typeof params.id === "string" ? parseInt(params.id.replace(/\D/g, "")) : params.id,
    user: typeof params.user === "string" ? params.user : params.user?.login,
    body: params.body,
    org: params.org,
    repo: params.repo,
    issueUrl: params.issueUrl,
  };
}

function updateTokenCount(text: string, tokenLimits: TokenLimits): void {
  const tokenCount = encode(text, { disallowedSpecial: new Set() }).length;
  tokenLimits.runningTokenCount += tokenCount;
  tokenLimits.tokensRemaining = tokenLimits.modelMaxTokenLimit - tokenLimits.maxCompletionTokens - tokenLimits.runningTokenCount;
}

function createDefaultTokenLimits(params: FetchParams): TokenLimits {
  return {
    modelMaxTokenLimit: params.context.adapters.openai.completions.getModelMaxTokenLimit(params.context.config.model),
    maxCompletionTokens: params.context.config.maxTokens,
    runningTokenCount: 0,
    tokensRemaining: 0,
  };
}

export async function handleIssue(
  params: FetchParams,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  alreadySeen: Set<string>,
  parentKey?: string,
  tokenLimits?: TokenLimits
) {
  const currentKey = `${params.owner}/${params.repo}/${params.issueNum}`;
  if (alreadySeen.has(currentKey)) {
    return;
  }

  // Mark this issue as seen
  alreadySeen.add(currentKey);

  const currentTokenLimits = tokenLimits || createDefaultTokenLimits(params);

  const {
    linkedIssues,
    seen,
    specAndBodies,
    streamlinedComments: streamlined,
  } = await fetchLinkedIssues(
    {
      ...params,
      parentIssueKey: parentKey,
    },
    currentTokenLimits
  );

  // Only fetch similar issues and README for the main issue (no parent key)
  if (!parentKey) {
    const issueBody = params.context.payload.issue?.body || "";
    const similarIssues = await fetchSimilarIssues(params.context, issueBody);
    const readmeSection = await pullReadmeFromRepoForIssue(params);

    params.context.logger.info(`Fetched ${similarIssues.length} similar issues and README section for ${currentKey}`);

    // Fetch Similar Comments
    const similarIssuesFromComment = await fetchLinkedIssuesFromComment(params.context, issueBody, params);

    // Add similar issues at the 0th level
    linkedIssues.push(...similarIssues, ...similarIssuesFromComment);

    // Add README content as a top-level comment if relevant
    if (readmeSection) {
      updateTokenCount(readmeSection, currentTokenLimits);

      if (!streamlined[currentKey]) {
        streamlined[currentKey] = [];
      }

      streamlined[currentKey].push(
        createStreamlinedComment({
          id: "readme-section",
          body: `Relevant README section:\n${readmeSection}`,
          user: params.context.payload.sender,
          org: params.owner || "",
          repo: params.repo || "",
          issueUrl: params.context.payload.issue?.html_url || "",
        })
      );
    }
  }

  // Merge seen sets to maintain global reference tracking
  for (const seenKey of seen) {
    alreadySeen.add(seenKey);
  }

  // Process each linked issue while maintaining the relationship to the current issue
  const fetchPromises = linkedIssues.map(async (linkedIssue) => {
    const linkedKey = createKey(linkedIssue.url, linkedIssue.issueNumber);
    if (alreadySeen.has(linkedKey)) {
      return;
    }
    return await mergeCommentsAndFetchSpec(
      {
        ...params,
        parentIssueKey: currentKey,
      },
      linkedIssue,
      streamlinedComments,
      specAndBodies,
      alreadySeen
    );
  });

  await throttlePromises(fetchPromises, 10);
  return mergeStreamlinedComments(streamlinedComments, streamlined);
}

export async function handleSpec(
  params: FetchParams,
  specOrBody: string,
  specAndBodies: Record<string, string>,
  key: string,
  seen: Set<string>,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  tokenLimits?: TokenLimits
) {
  if (seen.has(key)) {
    return specAndBodies;
  }

  const currentTokenLimits = tokenLimits || createDefaultTokenLimits(params);
  updateTokenCount(specOrBody, currentTokenLimits);

  specAndBodies[key] = specOrBody;
  const otherReferences = idIssueFromComment(specOrBody, params);

  if (otherReferences) {
    for (const ref of otherReferences) {
      const anotherKey = `${ref.owner}/${ref.repo}/${ref.issueNumber}`;
      if (seen.has(anotherKey)) {
        continue;
      }

      seen.add(anotherKey);
      const issue = await fetchIssue(
        {
          ...params,
          owner: ref.owner,
          repo: ref.repo,
          issueNum: ref.issueNumber,
        },
        currentTokenLimits
      );

      if (!issue?.body) {
        continue;
      }

      updateTokenCount(issue.body, currentTokenLimits);
      specAndBodies[anotherKey] = issue.body;

      if (!streamlinedComments[anotherKey]) {
        await handleIssue({ ...params, owner: ref.owner, repo: ref.repo, issueNum: ref.issueNumber }, streamlinedComments, seen, key, currentTokenLimits);
      }
    }
  }
  return specAndBodies;
}

export async function handleComment(
  params: FetchParams,
  comment: StreamlinedComment,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  seen: Set<string>,
  parentKey: string,
  tokenLimits?: TokenLimits
) {
  const commentBody = comment.body || "";
  const currentTokenLimits = tokenLimits || createDefaultTokenLimits(params);

  updateTokenCount(commentBody, currentTokenLimits);

  const otherReferences = idIssueFromComment(commentBody, params);

  // Only fetch code snippets for comments (no similar issues)
  const codeSnippets = await fetchCodeLinkedFromIssue(commentBody, params.context, comment.issueUrl);

  // Add code snippets as comments if found
  if (codeSnippets.length > 0) {
    const commentKey = `${params.owner}/${params.repo}/${params.issueNum}`;
    if (!streamlinedComments[commentKey]) {
      streamlinedComments[commentKey] = [];
    }

    codeSnippets.forEach((snippet) => {
      if (snippet.body) {
        updateTokenCount(snippet.body, currentTokenLimits);
      }

      streamlinedComments[commentKey].push(
        createStreamlinedComment({
          id: `code-${snippet.id}`,
          body: `Code from ${snippet.id}:\n\`\`\`\n${snippet.body || ""}\n\`\`\``,
          user: params.context.payload.sender,
          org: snippet.org,
          repo: snippet.repo,
          issueUrl: snippet.issueUrl,
        })
      );
    });
  }

  if (otherReferences) {
    for (const ref of otherReferences) {
      const key = `${ref.owner}/${ref.repo}/${ref.issueNumber}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      if (!streamlinedComments[key]) {
        await handleIssue({ ...params, owner: ref.owner, repo: ref.repo, issueNum: ref.issueNumber }, streamlinedComments, seen, parentKey, currentTokenLimits);
      }
    }
  }
}

export async function handleSpecAndBodyKeys(
  keys: string[],
  params: FetchParams,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  seen: Set<string>,
  tokenLimits?: TokenLimits
) {
  const currentTokenLimits = tokenLimits || createDefaultTokenLimits(params);

  const commentProcessingPromises = keys.map(async (key) => {
    if (seen.has(key)) {
      return;
    }

    const [owner, repo, issueNum] = splitKey(key);
    let comments = streamlinedComments[key];
    if (!comments || comments.length === 0) {
      await handleIssue({ ...params, owner, repo, issueNum: parseInt(issueNum) }, streamlinedComments, seen, key, currentTokenLimits);
      comments = streamlinedComments[key] || [];
    }

    for (const comment of comments) {
      await handleComment(params, comment, streamlinedComments, seen, key, currentTokenLimits);
    }
  });

  await throttlePromises(commentProcessingPromises, 10);
}

export async function throttlePromises(promises: Promise<void>[], limit: number) {
  const executing: Promise<void>[] = [];
  for (const promise of promises) {
    const p = promise.then(() => {
      void executing.splice(executing.indexOf(p), 1);
    });
    executing.push(p);
    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}
