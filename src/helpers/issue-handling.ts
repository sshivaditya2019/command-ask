import { createKey } from "../handlers/comments";
import { FetchParams } from "../types/github-types";
import { StreamlinedComment } from "../types/llm";
import { idIssueFromComment, mergeStreamlinedComments, splitKey } from "./issue";
import { fetchLinkedIssues, fetchIssue, mergeCommentsAndFetchSpec } from "./issue-fetching";

export async function handleIssue(
  params: FetchParams,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  alreadySeen: Set<string>,
  parentKey?: string
) {
  const currentKey = `${params.owner}/${params.repo}/${params.issueNum}`;
  if (alreadySeen.has(currentKey)) {
    return;
  }

  // Mark this issue as seen
  alreadySeen.add(currentKey);

  const {
    linkedIssues,
    seen,
    specAndBodies,
    streamlinedComments: streamlined,
  } = await fetchLinkedIssues({
    ...params,
    parentIssueKey: parentKey, // Pass parent key to maintain hierarchy
  });

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
        parentIssueKey: currentKey, // Set current issue as parent
      },
      linkedIssue,
      streamlinedComments,
      specAndBodies,
      alreadySeen // Pass the global seen set
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
  streamlinedComments: Record<string, StreamlinedComment[]>
) {
  if (seen.has(key)) {
    return specAndBodies;
  }

  specAndBodies[key] = specOrBody;
  const otherReferences = idIssueFromComment(specOrBody, params);

  if (otherReferences) {
    for (const ref of otherReferences) {
      const anotherKey = `${ref.owner}/${ref.repo}/${ref.issueNumber}`;
      if (seen.has(anotherKey)) {
        continue;
      }

      seen.add(anotherKey);
      const issue = await fetchIssue({
        ...params,
        owner: ref.owner,
        repo: ref.repo,
        issueNum: ref.issueNumber,
      });

      if (!issue?.body) {
        continue;
      }

      specAndBodies[anotherKey] = issue.body;

      if (!streamlinedComments[anotherKey]) {
        // Pass the current key as parent to maintain hierarchy
        await handleIssue(
          { ...params, owner: ref.owner, repo: ref.repo, issueNum: ref.issueNumber },
          streamlinedComments,
          seen, // Pass the same seen set
          key
        );
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
  parentKey: string
) {
  const otherReferences = idIssueFromComment(comment.body, params);
  if (otherReferences) {
    for (const ref of otherReferences) {
      const key = `${ref.owner}/${ref.repo}/${ref.issueNumber}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      if (!streamlinedComments[key]) {
        await handleIssue({ ...params, owner: ref.owner, repo: ref.repo, issueNum: ref.issueNumber }, streamlinedComments, seen, parentKey);
      }
    }
  }
}

export async function handleSpecAndBodyKeys(keys: string[], params: FetchParams, streamlinedComments: Record<string, StreamlinedComment[]>, seen: Set<string>) {
  // Process each key while maintaining parent-child relationships
  const commentProcessingPromises = keys.map(async (key) => {
    if (seen.has(key)) {
      return;
    }

    const [owner, repo, issueNum] = splitKey(key);
    let comments = streamlinedComments[key];
    if (!comments || comments.length === 0) {
      await handleIssue({ ...params, owner, repo, issueNum: parseInt(issueNum) }, streamlinedComments, seen, key);
      comments = streamlinedComments[key] || [];
    }

    // Process comments while maintaining the relationship to their parent issue
    for (const comment of comments) {
      await handleComment(params, comment, streamlinedComments, seen, key);
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
