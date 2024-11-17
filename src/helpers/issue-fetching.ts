import { Context } from "../types";
import { IssueComments, FetchParams, Issue, LinkedIssues, ReviewComments, SimplifiedComment } from "../types/github-types";
import { StreamlinedComment, TokenLimits } from "../types/llm";
import { logger } from "./errors";
import { dedupeStreamlinedComments, fetchCodeLinkedFromIssue, idIssueFromComment, mergeStreamlinedComments, splitKey } from "./issue";
import { handleIssue, handleSpec, handleSpecAndBodyKeys, throttlePromises } from "./issue-handling";
import { getAllStreamlinedComments } from "../handlers/comments";
import { processPullRequestDiff } from "./pull-request-parsing";

interface PullRequestDetails {
  diff: string | null;
  files?: string[];
}

interface EnhancedLinkedIssues extends LinkedIssues {
  prDetails?: PullRequestDetails;
}

export async function fetchIssue(params: FetchParams): Promise<Issue | null> {
  const { octokit, payload, logger } = params.context;
  const { issueNum, owner, repo } = params;

  // Ensure we have valid owner and repo
  const targetOwner = owner || payload.repository.owner.login;
  const targetRepo = repo || payload.repository.name;
  const targetIssueNum = issueNum || payload.issue.number;

  try {
    const response = await octokit.rest.issues.get({
      owner: targetOwner,
      repo: targetRepo,
      issue_number: targetIssueNum,
    });
    return response.data;
  } catch (error) {
    logger.error(`Error fetching issue`, {
      err: error,
      owner: targetOwner,
      repo: targetRepo,
      issue_number: targetIssueNum,
    });
    return null;
  }
}

export async function fetchIssueComments(params: FetchParams) {
  const { octokit, payload, logger } = params.context;
  const { issueNum, owner, repo } = params;

  // Ensure we have valid owner and repo
  const targetOwner = owner || payload.repository.owner.login;
  const targetRepo = repo || payload.repository.name;
  const targetIssueNum = issueNum || payload.issue.number;

  const issue = await fetchIssue({
    ...params,
    owner: targetOwner,
    repo: targetRepo,
    issueNum: targetIssueNum,
  });

  let reviewComments: ReviewComments[] = [];
  let issueComments: IssueComments[] = [];

  try {
    if (issue?.pull_request) {
      const response = await octokit.rest.pulls.listReviewComments({
        owner: targetOwner,
        repo: targetRepo,
        pull_number: targetIssueNum,
      });
      reviewComments = response.data;

      const response2 = await octokit.rest.issues.listComments({
        owner: targetOwner,
        repo: targetRepo,
        issue_number: targetIssueNum,
      });

      issueComments = response2.data;
    } else {
      const response = await octokit.rest.issues.listComments({
        owner: targetOwner,
        repo: targetRepo,
        issue_number: targetIssueNum,
      });
      issueComments = response.data;
    }
  } catch (e) {
    logger.error(`Error fetching comments`, {
      e,
      owner: targetOwner,
      repo: targetRepo,
      issue_number: targetIssueNum,
    });
  }

  const comments = [...issueComments, ...reviewComments].filter((comment) => comment.user?.type !== "Bot");
  const simplifiedComments = castCommentsToSimplifiedComments(comments, {
    ...params,
    owner: targetOwner,
    repo: targetRepo,
  });

  return {
    issue,
    comments: simplifiedComments,
  };
}

export async function fetchPullRequestDiff(context: Context, org: string, repo: string, issue: number, tokenLimits: TokenLimits) {
  const { octokit } = context;
  let diff: string;

  try {
    const diffResponse = await octokit.pulls.get({
      owner: org,
      repo,
      pull_number: issue,
      mediaType: { format: "diff" },
    });

    diff = diffResponse.data as unknown as string;
  } catch (e) {
    logger.error(`Error fetching PR data`, { owner: org, repo, issue, err: String(e) });
    return { diff: null };
  }

  return await processPullRequestDiff(diff, tokenLimits);
}

export async function recursivelyFetchLinkedIssues(params: FetchParams) {
  const maxDepth = params.maxDepth || 2;
  const currentDepth = params.currentDepth || 0;

  // Initialize tree structure with main issue as root
  const issueTree: Record<
    string,
    {
      issue: EnhancedLinkedIssues;
      children: string[];
      depth: number;
      parent?: string;
    }
  > = {};

  // Fetch the main issue first
  const mainIssue = await fetchIssue(params);
  if (!mainIssue) {
    return { linkedIssues: [], specAndBodies: {}, streamlinedComments: {} };
  }

  // Create the root node for the main issue
  const mainIssueKey = `${params.owner || params.context.payload.repository.owner.login}/${params.repo || params.context.payload.repository.name}/${params.issueNum || params.context.payload.issue.number}`;

  // If main issue is a PR, fetch its details
  let mainPrDetails: PullRequestDetails | undefined;
  if (mainIssue.pull_request) {
    const { diff } = await fetchPullRequestDiff(
      params.context,
      params.owner || params.context.payload.repository.owner.login,
      params.repo || params.context.payload.repository.name,
      params.issueNum || params.context.payload.issue.number,
      {
        modelMaxTokenLimit: 0,
        maxCompletionTokens: 0,
        runningTokenCount: 0,
        tokensRemaining: 0,
      }
    );
    mainPrDetails = { diff };
  }

  issueTree[mainIssueKey] = {
    issue: {
      body: mainIssue.body || "",
      owner: params.owner || params.context.payload.repository.owner.login,
      repo: params.repo || params.context.payload.repository.name,
      issueNumber: params.issueNum || params.context.payload.issue.number,
      url: mainIssue.html_url,
      comments: [],
      prDetails: mainPrDetails,
    },
    children: [],
    depth: 0,
  };

  // Fetch linked issues and comments for the main issue
  const { linkedIssues, seen, specAndBodies, streamlinedComments } = await fetchLinkedIssues({
    ...params,
    currentDepth,
    maxDepth,
  });

  // Process linked issues as children of the main issue
  if (currentDepth < maxDepth) {
    const fetchPromises = linkedIssues.map(async (linkedIssue) => {
      const issueKey = `${linkedIssue.owner}/${linkedIssue.repo}/${linkedIssue.issueNumber}`;

      // Skip if it's the main issue or already processed
      if (issueKey === mainIssueKey || seen.has(issueKey)) return;

      // Fetch PR details if this is a PR
      let prDetails: PullRequestDetails | undefined;
      if (linkedIssue.url.includes("/pull/")) {
        const { diff } = await fetchPullRequestDiff(params.context, linkedIssue.owner, linkedIssue.repo, linkedIssue.issueNumber, {
          modelMaxTokenLimit: 0,
          maxCompletionTokens: 0,
          runningTokenCount: 0,
          tokensRemaining: 0,
        });
        prDetails = { diff };
      }

      // Add to tree structure as child of main issue
      issueTree[issueKey] = {
        issue: {
          ...linkedIssue,
          prDetails,
        },
        children: [],
        depth: 1,
        parent: mainIssueKey,
      };
      issueTree[mainIssueKey].children.push(issueKey);

      return await mergeCommentsAndFetchSpec(
        {
          ...params,
          currentDepth: currentDepth + 1,
          maxDepth,
          parentIssueKey: issueKey,
        },
        linkedIssue,
        streamlinedComments,
        specAndBodies,
        seen
      );
    });
    await throttlePromises(fetchPromises, 10);
  }

  // Process gathered keys
  const linkedIssuesKeys = linkedIssues.map((issue) => `${issue.owner}/${issue.repo}/${issue.issueNumber}`);
  const specAndBodyKeys = Array.from(new Set([...Object.keys(specAndBodies), ...Object.keys(streamlinedComments), ...linkedIssuesKeys]));

  await handleSpecAndBodyKeys(
    specAndBodyKeys,
    {
      ...params,
      currentDepth,
      maxDepth,
    },
    dedupeStreamlinedComments(streamlinedComments),
    seen
  );
  return { linkedIssues, specAndBodies, streamlinedComments };
}

export async function fetchLinkedIssues(params: FetchParams) {
  const currentDepth = params.currentDepth || 0;
  const maxDepth = params.maxDepth || 2;

  if (currentDepth >= maxDepth) {
    return {
      streamlinedComments: {},
      linkedIssues: [],
      specAndBodies: {},
      seen: new Set<string>(),
    };
  }

  const fetchedIssueAndComments = await fetchIssueComments(params);
  if (!fetchedIssueAndComments.issue) {
    return { streamlinedComments: {}, linkedIssues: [], specAndBodies: {}, seen: new Set<string>() };
  }

  if (!params.owner || !params.repo) {
    throw logger.error("Owner or repo not found");
  }

  const issue = fetchedIssueAndComments.issue;
  const comments = fetchedIssueAndComments.comments.filter((comment) => comment.body !== undefined);

  const issueKey = `${params.owner}/${params.repo}/${params.issueNum}`;
  const linkedIssues: LinkedIssues[] = [
    {
      body: issue.body,
      comments,
      issueNumber: params.issueNum || 0,
      owner: params.owner,
      repo: params.repo,
      url: issue.html_url,
    },
  ];
  const specAndBodies: Record<string, string> = {};
  const seen = new Set<string>([issueKey]);

  // Add issue body as a comment
  const issueComment = {
    body: issue.body,
    user: issue.user,
    id: issue.id.toString(),
    org: params.owner,
    repo: params.repo,
    issueUrl: issue.html_url,
  };

  const allComments = [issueComment, ...comments];
  const processedUrls = new Set<string>();

  for (const comment of allComments) {
    if (!comment.body) continue;

    const foundIssues = idIssueFromComment(comment.body, params);
    const foundCodes = await fetchCodeLinkedFromIssue(comment.body, params.context, comment.issueUrl);

    if (foundIssues) {
      for (const linkedIssue of foundIssues) {
        const linkedKey = `${linkedIssue.owner}/${linkedIssue.repo}/${linkedIssue.issueNumber}`;
        const linkedUrl = linkedIssue.url;

        // Skip if we've already processed this URL or key
        if (seen.has(linkedKey) || processedUrls.has(linkedUrl)) continue;

        seen.add(linkedKey);
        processedUrls.add(linkedUrl);

        if (currentDepth < maxDepth) {
          const { comments: fetchedComments, issue: fetchedIssue } = await fetchIssueComments({
            ...params,
            issueNum: linkedIssue.issueNumber,
            owner: linkedIssue.owner,
            repo: linkedIssue.repo,
            currentDepth: currentDepth + 1,
          });

          if (!fetchedIssue || !fetchedIssue.body) continue;

          specAndBodies[linkedKey] = fetchedIssue.body;
          linkedIssue.body = fetchedIssue.body;
          linkedIssue.comments = fetchedComments;
          linkedIssues.push(linkedIssue);
        }
      }
    }

    if (foundCodes) {
      for (const code of foundCodes) {
        const codeComment = {
          body: code.body,
          user: code.user,
          id: code.id,
          org: code.org,
          repo: code.repo,
          issueUrl: code.issueUrl,
        };
        if (!allComments.some((c) => c.id === codeComment.id)) {
          allComments.push(codeComment);
        }
      }
    }
  }

  const streamlinedComments = await getAllStreamlinedComments(linkedIssues);
  return { streamlinedComments, linkedIssues, specAndBodies, seen };
}

export async function mergeCommentsAndFetchSpec(
  params: FetchParams,
  linkedIssue: LinkedIssues,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  specOrBodies: Record<string, string>,
  seen: Set<string>
) {
  if (linkedIssue.comments) {
    const streamed = await getAllStreamlinedComments([linkedIssue]);
    const merged = mergeStreamlinedComments(streamlinedComments, streamed);
    streamlinedComments = { ...streamlinedComments, ...merged };
  }

  if (linkedIssue.body) {
    await handleSpec(params, linkedIssue.body, specOrBodies, `${linkedIssue.owner}/${linkedIssue.repo}/${linkedIssue.issueNumber}`, seen, streamlinedComments);
  }
}

export async function fetchAndHandleIssue(
  key: string,
  params: FetchParams,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  seen: Set<string>
): Promise<StreamlinedComment[]> {
  const [owner, repo, issueNumber] = splitKey(key);
  const issueParams = { ...params, owner, repo, issueNum: parseInt(issueNumber) };
  await handleIssue(issueParams, streamlinedComments, seen);
  return streamlinedComments[key] || [];
}

function castCommentsToSimplifiedComments(comments: (IssueComments | ReviewComments)[], params: FetchParams): SimplifiedComment[] {
  if (!comments) {
    return [];
  }

  return comments
    .filter((comment) => comment.body !== undefined)
    .map((comment) => {
      if ("pull_request_review_id" in comment) {
        return {
          body: comment.body,
          user: comment.user,
          id: comment.id.toString(),
          org: params.owner || params.context.payload.repository.owner.login,
          repo: params.repo || params.context.payload.repository.name,
          issueUrl: comment.html_url,
        };
      }

      if ("html_url" in comment) {
        return {
          body: comment.body,
          user: comment.user,
          id: comment.id.toString(),
          org: params.owner || params.context.payload.repository.owner.login,
          repo: params.repo || params.context.payload.repository.name,
          issueUrl: comment.html_url,
        };
      }

      throw logger.error("Comment type not recognized", { comment, params });
    });
}
