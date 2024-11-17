import { Context } from "../types";
import { StreamlinedComment, TokenLimits } from "../types/llm";
import { fetchPullRequestDiff, fetchIssue } from "./issue-fetching";
import { splitKey } from "./issue";
import { logger } from "./errors";
import { Issue } from "../types/github-types";

interface TreeNode {
  key: string;
  issue: Issue;
  children: TreeNode[];
  parent?: TreeNode;
  depth: number;
  comments?: StreamlinedComment[];
  body?: string;
  prDetails?: {
    diff?: string | null;
    files?: {
      filename: string;
      changes: string;
    }[];
  };
}

function validateGitHubKey(key: string): boolean {
  // A valid key must be in the format owner/repo/number where:
  // - owner cannot be 'issues' (malformed cross-repo reference)
  // - owner and repo must be valid GitHub usernames/repo names (alphanumeric with hyphens and underscores)
  // - number must be digits only
  const parts = key.split("/");

  if (parts.length !== 3) return false;

  const [owner, repo, number] = parts;

  // Owner validation
  if (!owner || owner === "issues" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/i.test(owner)) {
    return false;
  }

  // Repo validation
  if (!repo || !/^[a-zA-Z0-9-_]+$/i.test(repo)) {
    return false;
  }

  return /^\d+$/.test(number);
}

function extractGitHubInfo(url: string): { owner: string; repo: string; number: string } | null {
  try {
    // Handle full GitHub URLs
    const urlMatch = url.match(/github\.com\/([^/]+)\/([^/]+?)\/(issues|pull)\/(\d+)/);
    if (urlMatch) {
      return {
        owner: urlMatch[1],
        repo: urlMatch[2],
        number: urlMatch[4],
      };
    }

    // Handle org/repo#number format
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

async function extractReferencedIssuesAndPrs(body: string, owner: string, repo: string, context: Context): Promise<string[]> {
  const links = new Set<string>();
  const processedRefs = new Set<string>();

  function addValidReference(key: string, source: string) {
    // Remove any square brackets that might have been included
    key = key.replace(/[[]]/g, "");

    if (!validateGitHubKey(key)) {
      context.logger.info(`Invalid GitHub key format: ${key} from ${source}`);
      return;
    }
    if (!processedRefs.has(key)) {
      context.logger.info(`Adding reference ${key} from ${source}`);
      processedRefs.add(key);
      links.add(key);
    }
  }

  // Match issue/PR references like #123 in the current repo
  const numberRefs = body.match(/(?:^|\s)#(\d+)(?:\s|$)/g) || [];
  for (const ref of numberRefs) {
    const number = ref.trim().substring(1);
    if (/^\d+$/.test(number)) {
      const key = `${owner}/${repo}/${number}`;
      addValidReference(key, "local reference");
    }
  }

  // Match "Resolves/Closes/Fixes #X" patterns
  const resolveRefs = body.match(/(?:Resolves|Closes|Fixes)\s+#(\d+)/gi) || [];
  for (const ref of resolveRefs) {
    const number = ref.split("#")[1];
    if (/^\d+$/.test(number)) {
      const key = `${owner}/${repo}/${number}`;
      addValidReference(key, "resolution reference");
    }
  }

  // Match full GitHub URLs
  const urlMatches = body.match(/https:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)\/(issues|pull)\/(\d+)(?:#[^/\s]*)?/g) || [];
  for (const url of urlMatches) {
    const info = extractGitHubInfo(url);
    if (info) {
      const key = `${info.owner}/${info.repo}/${info.number}`;
      addValidReference(key, "URL reference");
    }
  }

  // Match cross-repo references (org/repo#number)
  const crossRepoMatches = body.match(/([^/\s]+)\/([^/\s#]+)#(\d+)/g) || [];
  for (const ref of crossRepoMatches) {
    const parts = ref.match(/([^/\s]+)\/([^/\s#]+)#(\d+)/);
    if (parts) {
      const key = `${parts[1]}/${parts[2]}/${parts[3]}`;
      if (validateGitHubKey(key)) {
        // Additional validation check
        addValidReference(key, "cross-repo reference");
      }
    }
  }

  return Array.from(links);
}

async function buildTree(
  context: Context,
  streamlined: Record<string, StreamlinedComment[]>,
  specAndBodies: Record<string, string>,
  tokenLimits: TokenLimits
): Promise<TreeNode | null> {
  const processedNodes = new Map<string, TreeNode>();
  const mainIssueKey = `${context.payload.repository.owner.login}/${context.payload.repository.name}/${context.payload.issue.number}`;
  const maxDepth = 15;
  const linkedIssues = new Set<string>(); // Track all issues that have been linked anywhere in the tree
  const failedFetches = new Set<string>();
  const processingStack = new Set<string>();

  if (!validateGitHubKey(mainIssueKey)) {
    logger.error(`Invalid main issue key: ${mainIssueKey}`);
    return null;
  }

  async function findReferences(content: string, owner: string, repo: string): Promise<string[]> {
    const refs = await extractReferencedIssuesAndPrs(content, owner, repo, context);
    return refs.filter(
      (ref) => validateGitHubKey(ref) && !failedFetches.has(ref) && !linkedIssues.has(ref) // Only include refs that haven't been linked yet
    );
  }

  async function createNode(key: string, depth: number = 0): Promise<TreeNode | null> {
    // Prevent infinite recursion and respect max depth
    if (depth > maxDepth || processingStack.has(key)) {
      return processedNodes.get(key) || null;
    }

    // Return existing node if already processed
    if (processedNodes.has(key)) {
      const existingNode = processedNodes.get(key);
      if (existingNode) {
        return existingNode;
      }
    }

    // Don't retry failed fetches
    if (failedFetches.has(key)) {
      return null;
    }

    // Add to processing stack to prevent cycles
    processingStack.add(key);

    try {
      const [owner, repo, issueNum] = splitKey(key);
      const issue = await fetchIssue({
        context,
        owner,
        repo,
        issueNum: parseInt(issueNum),
      });

      if (!issue) {
        failedFetches.add(key);
        return null;
      }

      // Create the node first
      const node: TreeNode = {
        key,
        issue,
        children: [],
        depth,
        comments: streamlined[key],
        body: specAndBodies[key] || issue.body || undefined,
      };

      // Store node immediately to prevent cycles
      processedNodes.set(key, node);
      linkedIssues.add(key); // Mark this issue as linked

      // Collect all references
      const references = new Set<string>();
      // Add references from body
      if (node.body) {
        const bodyRefs = await findReferences(node.body, owner, repo);
        bodyRefs.forEach((ref) => references.add(ref));
      }

      // Add references from comments
      if (node.comments) {
        for (const comment of node.comments) {
          if (comment.body) {
            const commentRefs = await findReferences(comment.body, owner, repo);
            commentRefs.forEach((ref) => references.add(ref));
          }
        }
      }

      // Special handling for PR targets
      if (issue.pull_request && node.body) {
        const resolveMatches = node.body.match(/(?:Resolves|Closes|Fixes)\s+#(\d+)/gi);
        if (resolveMatches) {
          for (const match of resolveMatches) {
            const number = match.split("#")[1];
            const targetKey = `${owner}/${repo}/${number}`;
            if (validateGitHubKey(targetKey) && !linkedIssues.has(targetKey)) {
              references.add(targetKey);
            }
          }
        }
      }

      // Process all references as children
      for (const ref of references) {
        // Double check that the reference hasn't been linked while we were processing
        if (!linkedIssues.has(ref)) {
          const childNode = await createNode(ref, depth + 1);
          if (childNode) {
            childNode.parent = node;
            node.children.push(childNode);

            // Fetch PR details for PR nodes
            if (childNode.issue.pull_request) {
              try {
                const [childOwner, childRepo, childNum] = splitKey(ref);
                const { diff } = await fetchPullRequestDiff(context, childOwner, childRepo, parseInt(childNum), tokenLimits);

                const filesResponse = await context.octokit.pulls.listFiles({
                  owner: childOwner,
                  repo: childRepo,
                  pull_number: parseInt(childNum),
                });

                childNode.prDetails = {
                  diff: diff || undefined,
                  files: filesResponse.data.map((file) => ({
                    filename: file.filename,
                    changes: `${file.additions} additions, ${file.deletions} deletions, ${file.changes} changes`,
                  })),
                };
              } catch (error) {
                logger.error(`Error fetching PR details for ${ref}: ${error}`);
              }
            }
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
    return await createNode(mainIssueKey);
  } catch (error) {
    logger.error("Error building tree", { error: error as Error });
    return null;
  }
}

async function processTreeNode(node: TreeNode, prefix: string, output: string[]): Promise<void> {
  const isPullRequest = node.issue.pull_request;
  const typeStr = isPullRequest ? "PR" : "Issue";
  const numberStr = `#${node.issue.number}`;
  const urlStr = `(${node.issue.html_url})`;

  // Add node header
  output.push(`${prefix}${node.parent ? "└── " : ""}${typeStr} ${numberStr} ${urlStr}`);

  const childPrefix = prefix + (node.parent ? "    " : "");
  const contentPrefix = childPrefix + "    ";

  // Add body
  if (node.body) {
    output.push(`${childPrefix}Body:`);
    const bodyLines = node.body.trim().split("\n");
    bodyLines.forEach((line) => {
      if (line.trim()) {
        output.push(`${contentPrefix}${line.trim()}`);
      }
    });
    output.push("");
  }

  // Add PR details
  if (isPullRequest && node.prDetails) {
    if (node.prDetails.files && node.prDetails.files.length > 0) {
      output.push(`${childPrefix}Files Changed:`);
      node.prDetails.files.forEach((file) => {
        output.push(`${contentPrefix}- ${file.filename} (${file.changes})`);
      });
      output.push("");
    }

    if (node.prDetails.diff) {
      output.push(`${childPrefix}Diff Preview:`);
      const diffLines = node.prDetails.diff.split("\n").slice(0, 5);
      diffLines.forEach((line) => {
        output.push(`${contentPrefix}${line}`);
      });
      if (node.prDetails.diff.split("\n").length > 5) {
        output.push(`${contentPrefix}...`);
      }
      output.push("");
    }
  }

  // Add comments
  if (node.comments && node.comments.length > 0) {
    output.push(`${childPrefix}Comments: ${node.comments.length}`);
    node.comments.forEach((comment, index) => {
      if (comment.body) {
        const isLast = node.comments && index === node.comments.length - 1;
        const commentPrefix = isLast ? "└── " : "├── ";
        output.push(`${childPrefix}${commentPrefix}issuecomment-${comment.id}: ${comment.user}: ${comment.body.trim()}`);
      }
    });
    output.push("");
  }

  // Process children
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const isLast = i === node.children.length - 1;
    const nextPrefix = childPrefix + (isLast ? "    " : "│   ");
    await processTreeNode(child, nextPrefix, output);
  }
}

export async function formatChatHistory(
  context: Context,
  streamlined: Record<string, StreamlinedComment[]>,
  specAndBodies: Record<string, string>
): Promise<string[]> {
  const tokenLimits: TokenLimits = {
    modelMaxTokenLimit: context.adapters.openai.completions.getModelMaxTokenLimit(context.config.model),
    maxCompletionTokens: context.config.maxTokens || context.adapters.openai.completions.getModelMaxOutputLimit(context.config.model),
    runningTokenCount: 0,
    tokensRemaining: 0,
  };

  tokenLimits.tokensRemaining = tokenLimits.modelMaxTokenLimit - tokenLimits.maxCompletionTokens;

  // Build tree structure
  const tree = await buildTree(context, streamlined, specAndBodies, tokenLimits);
  if (!tree) {
    return ["No main issue found."];
  }

  const treeOutput: string[] = [];
  treeOutput.push("Issue Tree Structure:");
  treeOutput.push("");

  // Process tree
  await processTreeNode(tree, "", treeOutput);

  const result = treeOutput.join("\n");
  const tokenCount = await context.adapters.openai.completions.findTokenLength(result);

  if (tokenCount > tokenLimits.tokensRemaining) {
    logger.error("Tree structure exceeds token limit");
    return ["Tree structure exceeds token limit"];
  }

  return treeOutput;
}
