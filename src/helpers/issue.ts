import { FetchedCodes, FetchParams, LinkedIssues } from "../types/github-types";
import { StreamlinedComment } from "../types/llm";
import { Context } from "../types/context";
import { logger } from "./errors";

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
    // Remove any duplicate slashes and trailing slashes
    const cleanKey = key.replace(/\/+/g, "/").replace(/\/$/, "");
    const parts = cleanKey.split("/");

    // Handle various formats
    if (parts.length >= 3) {
      // Get the last three parts for owner/repo/number
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
  // First remove any URL encoding
  let cleanUrl = url;
  try {
    cleanUrl = decodeURIComponent(url);
  } catch {
    // If decoding fails, continue with original URL
    cleanUrl = url;
  }

  // Remove any square brackets and other unwanted characters
  cleanUrl = cleanUrl.replace(/[[]]/g, "");

  // Remove any duplicate slashes
  cleanUrl = cleanUrl.replace(/([^:])\/+/g, "$1/");

  // Remove any trailing slashes
  cleanUrl = cleanUrl.replace(/\/+$/, "");

  // Fix any malformed issue paths
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

  // Clean and decode the comment text
  const cleanedComment = cleanGitHubUrl(comment);

  // Match full GitHub URLs
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

  // Match cross-repo references (org/repo#123)
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

  // Match local references (#123)
  const hashPattern = /(?:^|\s)#(\d+)(?:$|\s|])/g;
  while ((match = hashPattern.exec(cleanedComment)) !== null) {
    const [_, number] = match;
    // Skip template placeholders
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

  // Match "Resolves/Closes/Fixes #X" patterns
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

  // Match "Depends on" references
  const dependsOnPattern = /Depends on (?:(?:#(\d+))|(?:https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)\/(issues|pull)\/(\d+)))(?:$|\s|])/g;
  while ((match = dependsOnPattern.exec(cleanedComment)) !== null) {
    if (match[1]) {
      // Local reference (#123)
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
      // Full URL
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
  extensions: string[] = [".ts", ".json", ".sol"]
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
          return { body: content, id: parsedUrl.path };
        }
      } catch (error) {
        logger.error(`Error fetching content from ${url}:`, { er: error });
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

export async function pullReadmeFromRepoForIssue(params: FetchParams): Promise<string | undefined> {
  let readme;
  try {
    const response = await params.context.octokit.repos.getContent({
      owner: params.context.payload.repository.owner?.login || params.context.payload.organization?.login || "",
      repo: params.context.payload.repository.name,
      path: "README.md",
    });
    if ("content" in response.data) {
      readme = Buffer.from(response.data.content, "base64").toString();
    }
  } catch (error) {
    throw logger.error(`Error fetching README from repository: ${error}`);
  }
  return readme;
}
