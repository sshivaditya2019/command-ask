import { RestEndpointMethodTypes } from "@octokit/rest";
import { Context } from "./context";

export type Issue = RestEndpointMethodTypes["issues"]["get"]["response"]["data"];
export type IssueComments = RestEndpointMethodTypes["issues"]["listComments"]["response"]["data"][0];
export type ReviewComments = RestEndpointMethodTypes["pulls"]["listReviewComments"]["response"]["data"][0];
export type User = RestEndpointMethodTypes["users"]["getByUsername"]["response"]["data"];

export type FetchParams = {
  context: Context;
  issueNum?: number;
  owner?: string;
  repo?: string;
  currentDepth?: number; // Current depth in the tree
  maxDepth?: number; // Maximum depth to traverse
  parentIssueKey?: string; // Parent issue key (Tree structure)
};

export type LinkedIssues = {
  issueNumber: number;
  repo: string;
  owner: string;
  url: string;
  comments?: SimplifiedComment[] | null | undefined;
  body: string | undefined | null;
};

export type SimplifiedComment = {
  user: Partial<User> | null;
  body: string | undefined | null;
  id: string;
  org: string;
  repo: string;
  issueUrl: string;
};

export type FetchedCodes = {
  body: string | undefined;
  user: Partial<User> | null;
  issueUrl: string;
  id: string;
  org: string;
  repo: string;
  issueNumber: number;
};
