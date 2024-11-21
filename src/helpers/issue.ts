import {
  FetchedCodes,
  FetchParams,
  GqlIssueCommentSearchResult,
  GqlIssueSearchResult,
  GqlPullRequestReviewCommentSearchResult,
  GqlPullRequestSearchResult,
  LinkedIssues,
} from "../types/github-types";
import { StreamlinedComment, TokenLimits } from "../types/llm";
import { Context } from "../types/context";
import { logger } from "./errors";
import { encode } from "gpt-tokenizer";

function updateTokenCount(text: string, tokenLimits: TokenLimits): void {
  const tokenCount = encode(text, { disallowedSpecial: new Set() }).length;
  tokenLimits.runningTokenCount += tokenCount;
  tokenLimits.tokensRemaining = tokenLimits.modelMaxTokenLimit - tokenLimits.maxCompletionTokens - tokenLimits.runningTokenCount;
}

export function dedupeStreamlinedComments(streamlinedComments: Record<string, StreamlinedComment[]>) {
  for (const key of Object.keys(streamlinedComments)) {
    streamlinedComments[key] = streamlinedComments[key].filter(
      (comment: StreamlinedComment, index: number, self: StreamlinedComment[]) => index === self.findIndex((t: StreamlinedComment) => t.body === comment.body)
    );
  }
  return streamlinedComments;
}

export function mergeStreamlinedComments(existingComments: Record<string, StreamlinedComment[]>, newComments: Record<string, StreamlinedComment[]>) {
  if (!existingComments) {
    existingComments = {};
  }
  for (const [key, value] of Object.entries(newComments)) {
    if (!existingComments[key]) {
      existingComments[key] = [];
    }
    const previous = existingComments[key] || [];
    existingComments[key] = [...previous, ...value];
  }
  return existingComments;
}

export function splitKey(key: string): [string, string, string] {
  try {
    const cleanKey = key.replace(/\/+/g, "/").replace(/\/$/, "");
    const parts = cleanKey.split("/");

    if (parts.length >= 3) {
      const lastThree = parts.slice(-3);
      return [lastThree[0], lastThree[1], lastThree[2]];
    }

    throw new Error("Invalid key format");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw logger.error("Invalid key format", { stack: err.stack });
  }
}

function cleanGitHubUrl(url: string): string {
  let cleanUrl = url;
  try {
    cleanUrl = decodeURIComponent(url);
  } catch {
    cleanUrl = url;
  }

  cleanUrl = cleanUrl.replace(/[[]]/g, "");
  cleanUrl = cleanUrl.replace(/([^:])\/+/g, "$1/");
  cleanUrl = cleanUrl.replace(/\/+$/, "");
  cleanUrl = cleanUrl.replace(/\/issues\/\d+\/issues\/\d+/, (match) => {
    const number = match.match(/\d+/)?.[0] || "";
    return `/issues/${number}`;
  });

  return cleanUrl;
}

export function idIssueFromComment(comment?: string | null, params?: FetchParams): LinkedIssues[] | null {
  if (!comment || !params) return null;

  const response: LinkedIssues[] = [];
  const seenKeys = new Set<string>();
  const cleanedComment = cleanGitHubUrl(comment);

  const urlPattern = /https:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)\/(issues|pull)\/(\d+)(?:$|#|\s|])/g;
  let match;
  while ((match = urlPattern.exec(cleanedComment)) !== null) {
    const [_, owner, repo, type, number] = match;
    const key = `${owner}/${repo}/${number}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      response.push({
        owner,
        repo,
        issueNumber: parseInt(number),
        url: `https://github.com/${owner}/${repo}/${type}/${number}`,
        body: undefined,
      });
    }
  }

  const crossRepoPattern = /([^/\s]+)\/([^/#\s]+)#(\d+)(?:$|\s|])/g;
  while ((match = crossRepoPattern.exec(cleanedComment)) !== null) {
    const [_, owner, repo, number] = match;
    const key = `${owner}/${repo}/${number}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      response.push({
        owner,
        repo,
        issueNumber: parseInt(number),
        url: `https://github.com/${owner}/${repo}/issues/${number}`,
        body: undefined,
      });
    }
  }

  const hashPattern = /(?:^|\s)#(\d+)(?:$|\s|])/g;
  while ((match = hashPattern.exec(cleanedComment)) !== null) {
    const [_, number] = match;
    if (number === "1234" && cleanedComment.includes("You must link the issue number e.g.")) {
      continue;
    }
    const owner = params.context.payload.repository?.owner?.login;
    const repo = params.context.payload.repository?.name;
    if (owner && repo) {
      const key = `${owner}/${repo}/${number}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        response.push({
          owner,
          repo,
          issueNumber: parseInt(number),
          url: `https://github.com/${owner}/${repo}/issues/${number}`,
          body: undefined,
        });
      }
    }
  }

  const resolvePattern = /(?:Resolves|Closes|Fixes)\s+#(\d+)(?:$|\s|])/gi;
  while ((match = resolvePattern.exec(cleanedComment)) !== null) {
    const [_, number] = match;
    const owner = params.context.payload.repository?.owner?.login;
    const repo = params.context.payload.repository?.name;
    if (owner && repo) {
      const key = `${owner}/${repo}/${number}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        response.push({
          owner,
          repo,
          issueNumber: parseInt(number),
          url: `https://github.com/${owner}/${repo}/issues/${number}`,
          body: undefined,
        });
      }
    }
  }

  const dependsOnPattern = /Depends on (?:(?:#(\d+))|(?:https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)\/(issues|pull)\/(\d+)))(?:$|\s|])/g;
  while ((match = dependsOnPattern.exec(cleanedComment)) !== null) {
    if (match[1]) {
      const owner = params.context.payload.repository?.owner?.login;
      const repo = params.context.payload.repository?.name;
      if (owner && repo) {
        const key = `${owner}/${repo}/${match[1]}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          response.push({
            owner,
            repo,
            issueNumber: parseInt(match[1]),
            url: `https://github.com/${owner}/${repo}/issues/${match[1]}`,
            body: undefined,
          });
        }
      }
    } else if (match[2] && match[3] && match[5]) {
      const key = `${match[2]}/${match[3]}/${match[5]}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        response.push({
          owner: match[2],
          repo: match[3],
          issueNumber: parseInt(match[5]),
          url: `https://github.com/${match[2]}/${match[3]}/${match[4]}/${match[5]}`,
          body: undefined,
        });
      }
    }
  }
  return response.length > 0 ? response : null;
}

export async function fetchCodeLinkedFromIssue(
  issue: string,
  context: Context,
  url: string,
  extensions: string[] = [".ts", ".json", ".sol"],
  tokenLimits?: TokenLimits
): Promise<FetchedCodes[]> {
  const { octokit } = context;

  function parseGitHubUrl(url: string): { owner: string; repo: string; path: string } | null {
    const cleanUrl = cleanGitHubUrl(url);
    const match = cleanUrl.match(/https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)\/blob\/[^/]+\/(.+)/);
    return match ? { owner: match[1], repo: match[2], path: match[3] } : null;
  }

  function hasValidExtension(path: string) {
    const cleanPath = path.split("#")[0];
    return extensions.some((ext) => cleanPath.toLowerCase().endsWith(ext.toLowerCase()));
  }

  function removeLineNumbers(url: string) {
    const match = url.match(/(.*?)(#L\d+(-L\d+)?)/);
    return match ? match[1] : url;
  }

  const urls = issue.match(/https?:\/\/(?:www\.)?github\.com\/[^\s]+/g) || [];
  const results = await Promise.all(
    urls.map(async (url) => {
      let parsedUrl = parseGitHubUrl(url);
      parsedUrl = parsedUrl ? { ...parsedUrl, path: removeLineNumbers(parsedUrl.path) } : null;
      if (!parsedUrl || !hasValidExtension(parsedUrl.path)) return null;

      try {
        const commitSha = url.match(/https?:\/\/github\.com\/[^/]+\/[^/]+?\/blob\/([^/]+)\/.+/);
        let response;
        if (commitSha) {
          response = await octokit.repos.getContent({
            owner: parsedUrl.owner,
            repo: parsedUrl.repo,
            ref: commitSha[1],
            path: parsedUrl.path,
          });
        } else {
          response = await octokit.repos.getContent({
            owner: parsedUrl.owner,
            repo: parsedUrl.repo,
            path: parsedUrl.path,
          });
        }

        if ("content" in response.data) {
          const content = Buffer.from(response.data.content, "base64").toString();
          if (tokenLimits) {
            updateTokenCount(content, tokenLimits);
          }
          return { body: content, id: parsedUrl.path };
        }
      } catch (error) {
        logger.error(`Error fetching content from ${url}:`, { stack: error instanceof Error ? error.stack : String(error) });
      }
      return null;
    })
  );

  return results
    .filter((result): result is { body: string; id: string } => result !== null)
    .map((result) => ({
      ...result,
      org: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issueNumber: parseInt(issue.match(/\/issues\/(\d+)/)?.[1] || "0", 10),
      issueUrl: url,
      user: context.payload.sender,
    }));
}

export async function pullReadmeFromRepoForIssue(params: FetchParams, tokenLimits?: TokenLimits): Promise<string | undefined> {
  let readme;
  try {
    const response = await params.context.octokit.repos.getContent({
      owner: params.context.payload.repository.owner?.login || params.context.payload.organization?.login || "",
      repo: params.context.payload.repository.name,
      path: "README.md",
    });
    if ("content" in response.data) {
      readme = Buffer.from(response.data.content, "base64").toString();
      if (tokenLimits) {
        updateTokenCount(readme, tokenLimits);
      }
    }
  } catch (error) {
    throw logger.error(`Error fetching README from repository:`, { stack: error instanceof Error ? error.stack : String(error) });
  }
  logger.info("Readme fetched from repository");
  return readme;
}

export async function fetchSimilarIssues(context: Context, question: string, tokenLimits?: TokenLimits): Promise<LinkedIssues[]> {
  const {
    adapters: {
      supabase: { issue },
    },
    octokit,
    config: { similarityThreshold },
  } = context;

  try {
    const similarIssues = await issue.findSimilarIssues(question, 1 - similarityThreshold, "");
    const linkedIssues: LinkedIssues[] = [];

    if (similarIssues) {
      for (const similarIssue of similarIssues) {
        try {
          const issueId = similarIssue.issue_id;
          const issueFetched: GqlIssueSearchResult = await octokit.graphql(
            `
            query ($nodeId: ID!) {
              node(id: $nodeId) {
                ... on Issue {
                  number
                  url
                  body
                  repository {
                    owner {
                      login
                    }
                    name
                  }
                }
              }
            }
            `,
            {
              nodeId: issueId,
            }
          );

          if (issueFetched?.node) {
            if (tokenLimits && issueFetched.node.body) {
              updateTokenCount(issueFetched.node.body, tokenLimits);
            }
            linkedIssues.push({
              issueNumber: issueFetched.node.number,
              owner: issueFetched.node.repository.owner.login,
              repo: issueFetched.node.repository.name,
              url: issueFetched.node.url,
              body: issueFetched.node.body,
            });
          }
        } catch (error) {
          logger.error(`Error fetching similar issue ${similarIssue.issue_id}:`, { stack: error instanceof Error ? error.stack : String(error) });
          continue;
        }
      }
    }
    return linkedIssues;
  } catch (error) {
    logger.error("Error in fetchSimilarIssues:", { stack: error instanceof Error ? error.stack : String(error) });
    return [];
  }
}

export async function fetchLinkedIssuesFromComment(
  context: Context,
  commentBody: string,
  params: FetchParams,
  tokenLimits?: TokenLimits
): Promise<LinkedIssues[]> {
  const {
    adapters: {
      supabase: { comment },
    },
    octokit,
    config: { similarityThreshold },
  } = context;

  try {
    const similarComments = await comment.findSimilarComments(commentBody, 1 - similarityThreshold, "");
    const linkedIssues: LinkedIssues[] = [];

    if (similarComments) {
      for (const similarComment of similarComments) {
        try {
          const commentId = similarComment.comment_id;
          const commentFetched: { node: { __typename: string } } = await octokit.graphql(
            `
              query ($nodeId: ID!) {
              node(id: $nodeId) {
                __typename
                ... on PullRequest {
                  id
                  body
                  closingIssuesReferences(first: 1) {
                    nodes {
                      number
                      url
                      body
                      repository {
                        owner {
                          login
                        }
                        name
                      }
                    }
                  }
                }
                ... on PullRequestReviewComment {
                  id
                  body
                  pullRequest {
                    id
                    title
                    url
                    body
                    repository {
                      owner {
                        login
                      }
                      name
                    }
                  }
                }
                ... on IssueComment {
                  id
                  body
                  issue {
                    number
                    url
                    body
                    repository {
                      owner {
                        login
                      }
                      name
                    }
                  }
                }
              }
            }
            `,
            {
              nodeId: commentId,
            }
          );

          if (commentFetched?.node?.__typename) {
            if (commentFetched.node.__typename === "IssueComment") {
              const issueCommentNode = commentFetched as unknown as GqlIssueCommentSearchResult;
              if (tokenLimits && issueCommentNode.node.issue.body) {
                updateTokenCount(issueCommentNode.node.issue.body, tokenLimits);
              }
              linkedIssues.push({
                issueNumber: issueCommentNode.node.issue.number,
                owner: issueCommentNode.node.issue.repository.owner.login,
                repo: issueCommentNode.node.issue.repository.name,
                url: issueCommentNode.node.issue.url,
                body: issueCommentNode.node.issue.body,
              });
            } else if (commentFetched.node.__typename === "PullRequest") {
              const pullRequestNode = commentFetched as unknown as GqlPullRequestSearchResult;
              const issueData = pullRequestNode.node.closingIssuesReferences.nodes[0];
              if (tokenLimits && issueData.body) {
                updateTokenCount(issueData.body, tokenLimits);
              }
              linkedIssues.push({
                issueNumber: issueData.number,
                owner: issueData.repository.owner.login,
                repo: issueData.repository.name,
                url: issueData.url,
                body: issueData.body,
              });
            } else if (commentFetched.node.__typename === "PullRequestReviewComment") {
              const pullRequestReviewCommentNode = commentFetched as unknown as GqlPullRequestReviewCommentSearchResult;
              const issueData = pullRequestReviewCommentNode.node.pullRequest.closingIssuesReferences.nodes[0];
              if (tokenLimits && issueData.body) {
                updateTokenCount(issueData.body, tokenLimits);
              }
              linkedIssues.push({
                issueNumber: issueData.number,
                owner: issueData.repository.owner.login,
                repo: issueData.repository.name,
                url: issueData.url,
                body: issueData.body,
              });
            }
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.error(`Error processing comment ${similarComment.comment_id}:`, { stack: err.stack });
          continue;
        }
      }
    }
    return linkedIssues;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Error in fetchLinkedIssuesFromComment:", { stack: err.stack });
    return [];
  }
}
