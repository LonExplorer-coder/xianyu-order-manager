import type {
  Candidate,
  CandidateAdjudicationFailureCode,
  CandidateContextLine,
  CandidateModelProvider,
  CandidateRegion,
} from './candidate-verification';

export type CandidateAdjudicationRunStatus =
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'rejected';

export type CandidateAdjudicationDecisionOutcome =
  | 'selected'
  | 'unresolved'
  | 'invalid';

export type CandidateAdjudicationDecisionAudit = {
  ambiguityId: string;
  region: CandidateRegion;
  field: string;
  itemIndex?: number;
  candidates: Candidate[];
  contextLines: CandidateContextLine[];
  selectedCandidateId?: string;
  outcome: CandidateAdjudicationDecisionOutcome;
  failureCode?: CandidateAdjudicationFailureCode;
};

export type CandidateAdjudicationAudit = {
  provider: CandidateModelProvider;
  model: string;
  status: CandidateAdjudicationRunStatus;
  failureCode?: CandidateAdjudicationFailureCode;
  failureMessage?: string;
  decisions: CandidateAdjudicationDecisionAudit[];
};

export type CandidateAdjudicationDecisionAuditView =
  CandidateAdjudicationDecisionAudit;

export type CandidateAdjudicationAuditView = Omit<
  CandidateAdjudicationAudit,
  'decisions'
> & {
  id: string;
  createdAt: string;
  decisions: CandidateAdjudicationDecisionAuditView[];
};
