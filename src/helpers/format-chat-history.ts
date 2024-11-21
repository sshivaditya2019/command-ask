import { Context } from "../types";
import { StreamlinedComment, TokenLimits } from "../types/llm";
import { fetchIssue, fetchLinkedIssues } from "./issue-fetching";
import { splitKey } from "./issue";
import { logger } from "./errors";
import { Issue, LinkedIssues } from "../types/github-types";
import { encode } from "gpt-tokenizer";

interface TreeNode {
  key: string;
  issue: Issue;
  children: TreeNode[];
  parent?: TreeNode;
  depth: number;
  comments?: StreamlinedComment[];
  body?: string;
  similarIssues?: Issue[];
  codeSnippets?: { body: string; path: string }[];
  readmeSection?: string;
}

function updateTokenCount(text: string, tokenLimits: TokenLimits): void {
  const tokenCount = encode(text, { disallowedSpecial: new Set() }).length;
  tokenLimits.runningTokenCount += tokenCount;
  tokenLimits.tokensRemaining = tokenLimits.modelMaxTokenLimit - tokenLimits.maxCompletionTokens - tokenLimits.runningTokenCount;
}

function validateGitHubKey(key: string): boolean {
  const parts = key.split("/");

  if (parts.length !== 3) return false;

  const [owner, repo, number] = parts;

  if (!owner || owner === "issues" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/i.test(owner)) {
    return false;
  }

  if (!repo || !/^[a-zA-Z0-9-_]+$/i.test(repo)) {
    return false;
  }

  return /^\d+$/.test(number);
}

function extractGitHubInfo(url: string): { owner: string; repo: string; number: string } | null {
  try {
    const urlMatch = url.match(/github\.com\/([^/]+)\/([^/]+?)\/(issues|pull)\/(\d+)/);
    if (urlMatch) {
      return {
        owner: urlMatch[1],
        repo: urlMatch[2],
        number: urlMatch[4],
      };
    }

    const repoMatch = url.match(/([^/\s]+)\/([^/\s#]+)#(\d+)/);
    if (repoMatch) {
      return {
        owner: repoMatch[1],
        repo: repoMatch[2],
        number: repoMatch[3],
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function extractReferencedIssuesAndPrs(body: string, owner: string, repo: string): Promise<string[]> {
  const links = new Set<string>();
  const processedRefs = new Set<string>();

  function addValidReference(key: string) {
    key = key.replace(/[[]]/g, "");

    if (!validateGitHubKey(key)) {
      return;
    }
    if (!processedRefs.has(key)) {
      processedRefs.add(key);
      links.add(key);
    }
  }

  const numberRefs = body.match(/(?:^|\s)#(\d+)(?:\s|$)/g) || [];
  for (const ref of numberRefs) {
    const number = ref.trim().substring(1);
    if (/^\d+$/.test(number)) {
      const key = `${owner}/${repo}/${number}`;
      addValidReference(key);
    }
  }

  const resolveRefs = body.match(/(?:Resolves|Closes|Fixes)\s+#(\d+)/gi) || [];
  for (const ref of resolveRefs) {
    const number = ref.split("#")[1];
    if (/^\d+$/.test(number)) {
      const key = `${owner}/${repo}/${number}`;
      addValidReference(key);
    }
  }

  const urlMatches = body.match(/https:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)\/(issues|pull)\/(\d+)(?:#[^/\s]*)?/g) || [];
  for (const url of urlMatches) {
    const info = extractGitHubInfo(url);
    if (info) {
      const key = `${info.owner}/${info.repo}/${info.number}`;
      addValidReference(key);
    }
  }

  const crossRepoMatches = body.match(/([^/\s]+)\/([^/\s#]+)#(\d+)/g) || [];
  for (const ref of crossRepoMatches) {
    const parts = ref.match(/([^/\s]+)\/([^/\s#]+)#(\d+)/);
    if (parts) {
      const key = `${parts[1]}/${parts[2]}/${parts[3]}`;
      if (validateGitHubKey(key)) {
        addValidReference(key);
      }
    }
  }

  return Array.from(links);
}

async function buildTree(
  context: Context,
  streamlined: Record<string, StreamlinedComment[]>,
  specAndBodies: Record<string, string>,
  tokenLimits: TokenLimits,
  maxDepth: number = 2
): Promise<{ tree: TreeNode | null; linkedIssues: LinkedIssues[] }> {
  const processedNodes = new Map<string, TreeNode>();
  const mainIssueKey = `${context.payload.repository.owner.login}/${context.payload.repository.name}/${context.payload.issue.number}`;
  const linkedIssueKeys = new Set<string>();
  const failedFetches = new Set<string>();
  const processingStack = new Set<string>();

  if (!validateGitHubKey(mainIssueKey)) {
    logger.error(`Invalid main issue key: ${mainIssueKey}`);
    return { tree: null, linkedIssues: [] };
  }

  const { linkedIssues } = await fetchLinkedIssues(
    {
      context,
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issueNum: context.payload.issue.number,
    },
    tokenLimits
  );

  async function createNode(key: string, depth: number = 0): Promise<TreeNode | null> {
    if (depth > maxDepth || processingStack.has(key)) {
      return processedNodes.get(key) || null;
    }

    if (processedNodes.has(key)) {
      return processedNodes.get(key) || null;
    }

    if (failedFetches.has(key)) {
      return null;
    }

    processingStack.add(key);

    try {
      const [owner, repo, issueNum] = splitKey(key);
      const issue = await fetchIssue(
        {
          context,
          owner,
          repo,
          issueNum: parseInt(issueNum),
        },
        tokenLimits
      );

      if (!issue) {
        failedFetches.add(key);
        return null;
      }

      const node: TreeNode = {
        key,
        issue,
        children: [],
        depth,
        comments: streamlined[key],
        body: specAndBodies[key] || issue.body || undefined,
      };

      processedNodes.set(key, node);
      linkedIssueKeys.add(key);

      const references = new Set<string>();

      if (node.body) {
        const bodyRefs = await extractReferencedIssuesAndPrs(node.body, owner, repo);
        bodyRefs.forEach((ref) => references.add(ref));
      }

      if (node.comments) {
        for (const comment of node.comments) {
          if (comment.body) {
            const commentRefs = await extractReferencedIssuesAndPrs(comment.body, owner, repo);
            commentRefs.forEach((ref) => references.add(ref));
          }
        }
      }

      if (issue.pull_request && node.body) {
        const resolveMatches = node.body.match(/(?:Resolves|Closes|Fixes)\s+#(\d+)/gi);
        if (resolveMatches) {
          for (const match of resolveMatches) {
            const number = match.split("#")[1];
            const targetKey = `${owner}/${repo}/${number}`;
            if (validateGitHubKey(targetKey) && !linkedIssueKeys.has(targetKey)) {
              references.add(targetKey);
            }
          }
        }
      }

      // Process all references regardless of token count
      for (const ref of references) {
        if (!linkedIssueKeys.has(ref)) {
          const childNode = await createNode(ref, depth + 1);
          if (childNode) {
            childNode.parent = node;
            node.children.push(childNode);
          }
        }
      }
      return node;
    } catch (error) {
      failedFetches.add(key);
      logger.error(`Error creating node for ${key}: ${error}`);
      return null;
    } finally {
      processingStack.delete(key);
    }
  }

  try {
    const tree = await createNode(mainIssueKey);
    return { tree, linkedIssues };
  } catch (error) {
    logger.error("Error building tree", { error: error as Error });
    return { tree: null, linkedIssues };
  }
}

async function processTreeNode(node: TreeNode, prefix: string, output: string[], tokenLimits: TokenLimits, linkedIssues?: LinkedIssues[]): Promise<void> {
  const isPullRequest = node.issue.pull_request;
  const typeStr = isPullRequest ? "PR" : "Issue";
  const numberStr = `#${node.issue.number}`;
  const urlStr = `(${node.issue.html_url})`;

  // Check token limit before adding this node
  const headerLine = `${prefix}${node.parent ? "└── " : ""}${typeStr} ${numberStr} ${urlStr}`;
  const headerTokens = encode(headerLine, { disallowedSpecial: new Set() }).length;

  if (tokenLimits.runningTokenCount + headerTokens > tokenLimits.tokensRemaining) {
    return; // Stop here if we can't add even the header
  }

  updateTokenCount(headerLine, tokenLimits);
  output.push(headerLine);

  const childPrefix = prefix + (node.parent ? "    " : "");
  const contentPrefix = childPrefix + "    ";

  if (node.body) {
    const bodyHeader = `${childPrefix}Body:`;
    const bodyHeaderTokens = encode(bodyHeader, { disallowedSpecial: new Set() }).length;

    if (tokenLimits.runningTokenCount + bodyHeaderTokens <= tokenLimits.tokensRemaining) {
      updateTokenCount(bodyHeader, tokenLimits);
      output.push(bodyHeader);

      const bodyLines = node.body.trim().split("\n");
      for (const line of bodyLines) {
        if (line.trim()) {
          const formattedLine = `${contentPrefix}${line.trim()}`;
          const lineTokens = encode(formattedLine, { disallowedSpecial: new Set() }).length;

          if (tokenLimits.runningTokenCount + lineTokens > tokenLimits.tokensRemaining) {
            break; // Stop adding body lines if we hit the limit
          }

          updateTokenCount(formattedLine, tokenLimits);
          output.push(formattedLine);
        }
      }
      output.push("");
    }
  }

  // Add README section for the main issue (no parent)
  if (!node.parent && linkedIssues?.[0]?.readme) {
    const readmeHeader = `${childPrefix}README:`;
    const readmeHeaderTokens = encode(readmeHeader, { disallowedSpecial: new Set() }).length;

    if (tokenLimits.runningTokenCount + readmeHeaderTokens <= tokenLimits.tokensRemaining) {
      updateTokenCount(readmeHeader, tokenLimits);
      output.push(readmeHeader);

      const readmeLines = linkedIssues[0].readme.trim().split("\n");
      for (const line of readmeLines) {
        if (line.trim()) {
          const formattedLine = `${contentPrefix}${line.trim()}`;
          const lineTokens = encode(formattedLine, { disallowedSpecial: new Set() }).length;

          if (tokenLimits.runningTokenCount + lineTokens > tokenLimits.tokensRemaining) {
            break; // Stop adding readme lines if we hit the limit
          }

          updateTokenCount(formattedLine, tokenLimits);
          output.push(formattedLine);
        }
      }
      output.push("");
    }
  }

  if (node.comments && node.comments.length > 0) {
    const commentsHeader = `${childPrefix}Comments: ${node.comments.length}`;
    const headerTokens = encode(commentsHeader, { disallowedSpecial: new Set() }).length;

    if (tokenLimits.runningTokenCount + headerTokens <= tokenLimits.tokensRemaining) {
      updateTokenCount(commentsHeader, tokenLimits);
      output.push(commentsHeader);

      for (let i = 0; i < node.comments.length; i++) {
        const comment = node.comments[i];
        if (comment.body) {
          const isLast = i === node.comments.length - 1;
          const commentPrefix = isLast ? "└── " : "├── ";
          const commentLine = `${childPrefix}${commentPrefix}issuecomment-${comment.id}: ${comment.user}: ${comment.body.trim()}`;
          const commentTokens = encode(commentLine, { disallowedSpecial: new Set() }).length;

          if (tokenLimits.runningTokenCount + commentTokens > tokenLimits.tokensRemaining) {
            break; // Stop adding comments if we hit the limit
          }

          updateTokenCount(commentLine, tokenLimits);
          output.push(commentLine);
        }
      }
      output.push("");
    }
  }

  // Process children
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const isLast = i === node.children.length - 1;
    const nextPrefix = childPrefix + (isLast ? "    " : "│   ");

    // Check if we have enough tokens for at least the child's header
    const childHeaderLine = `${nextPrefix}${child.parent ? "└── " : ""}${child.issue.pull_request ? "PR" : "Issue"} #${child.issue.number} (${child.issue.html_url})`;
    const childHeaderTokens = encode(childHeaderLine, { disallowedSpecial: new Set() }).length;

    if (tokenLimits.runningTokenCount + childHeaderTokens > tokenLimits.tokensRemaining) {
      break; // Stop processing children if we can't even add their headers
    }

    await processTreeNode(child, nextPrefix, output, tokenLimits, linkedIssues);
  }
}

export async function formatChatHistory(
  context: Context,
  streamlined: Record<string, StreamlinedComment[]>,
  specAndBodies: Record<string, string>,
  maxDepth: number = 2
): Promise<string[]> {
  const tokenLimits: TokenLimits = {
    modelMaxTokenLimit: context.adapters.openai.completions.getModelMaxTokenLimit(context.config.model),
    maxCompletionTokens: context.config.maxTokens || context.adapters.openai.completions.getModelMaxOutputLimit(context.config.model),
    runningTokenCount: 0,
    tokensRemaining: 0,
  };

  tokenLimits.tokensRemaining = tokenLimits.modelMaxTokenLimit - tokenLimits.maxCompletionTokens;

  const { tree, linkedIssues } = await buildTree(context, streamlined, specAndBodies, tokenLimits, maxDepth);
  if (!tree) {
    return ["No main issue found."];
  }

  // Reset token count before processing tree for output
  tokenLimits.runningTokenCount = 0;
  tokenLimits.tokensRemaining = tokenLimits.modelMaxTokenLimit - tokenLimits.maxCompletionTokens;

  const treeOutput: string[] = [];
  const headerLine = "Issue Tree Structure:";
  updateTokenCount(headerLine, tokenLimits);
  treeOutput.push(headerLine);
  treeOutput.push("");

  await processTreeNode(tree, "", treeOutput, tokenLimits, linkedIssues);
  logger.info(`Final token count: ${tokenLimits.runningTokenCount}/${tokenLimits.tokensRemaining} tokens used`);

  return treeOutput;
}
