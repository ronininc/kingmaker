-- Ronin / Solomon — SQLite Initial Schema v1
-- Local-first database schema for Solomon Customer Runtime and Kingmaker Internal Runtime.
-- SQLite is the launch storage layer. Postgres can mirror/scale later without changing entity doctrine.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  organization_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  industry TEXT,
  owner_user_id TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('SOLOMON_CUSTOMER', 'KINGMAKER_INTERNAL')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED', 'BLOCKED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'FOUNDER', 'RONIN_OPERATOR')),
  preferred_address TEXT,
  default_surface TEXT NOT NULL CHECK (default_surface IN ('SOLOMON_CUSTOMER', 'KINGMAKER_INTERNAL')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_organization_id ON users(organization_id);

CREATE TABLE IF NOT EXISTS objectives (
  objective_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('REVENUE', 'OPERATIONS', 'MARKETING', 'SALES', 'CUSTOMER_SUCCESS', 'PRODUCT', 'DEVELOPMENT', 'INTERNAL_RONIN', 'CUSTOM')),
  current_state_plain TEXT NOT NULL,
  target_state_plain TEXT NOT NULL,
  success_conditions_json TEXT NOT NULL DEFAULT '[]',
  completion_conditions_json TEXT NOT NULL DEFAULT '[]',
  expansion_options_json TEXT NOT NULL DEFAULT '[]',
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent >= 0 AND progress_percent <= 100),
  confidence INTEGER NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
  risk_plain TEXT NOT NULL DEFAULT 'UNKNOWN',
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED', 'BLOCKED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_objectives_organization_id ON objectives(organization_id);
CREATE INDEX IF NOT EXISTS idx_objectives_status ON objectives(status);

CREATE TABLE IF NOT EXISTS recommendations (
  recommendation_id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL REFERENCES objectives(objective_id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  reasoning_plain TEXT NOT NULL,
  evidence_package_id TEXT,
  expected_impact_plain TEXT NOT NULL,
  cost_class TEXT NOT NULL CHECK (cost_class IN ('FREE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  risk_class TEXT NOT NULL CHECK (risk_class IN ('GREEN', 'YELLOW', 'RED', 'BLACK')),
  confidence INTEGER NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED', 'RUNNING', 'MEASURED', 'ARCHIVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recommendations_objective_id ON recommendations(objective_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_organization_id ON recommendations(organization_id);

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  objective_id TEXT REFERENCES objectives(objective_id) ON DELETE SET NULL,
  recommendation_id TEXT REFERENCES recommendations(recommendation_id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  trigger_plain TEXT NOT NULL,
  actions_json TEXT NOT NULL DEFAULT '[]',
  approval_class TEXT NOT NULL CHECK (approval_class IN ('GREEN', 'YELLOW', 'RED')),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'REVIEW', 'APPROVED', 'RUNNING', 'COMPLETED', 'MEASURED', 'ARCHIVED', 'BLOCKED')),
  expected_outcome_plain TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflows_organization_id ON workflows(organization_id);
CREATE INDEX IF NOT EXISTS idx_workflows_objective_id ON workflows(objective_id);

CREATE TABLE IF NOT EXISTS outcomes (
  outcome_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  objective_id TEXT NOT NULL REFERENCES objectives(objective_id) ON DELETE CASCADE,
  recommendation_id TEXT REFERENCES recommendations(recommendation_id) ON DELETE SET NULL,
  workflow_id TEXT REFERENCES workflows(workflow_id) ON DELETE SET NULL,
  expected_result_plain TEXT NOT NULL,
  actual_result_plain TEXT NOT NULL,
  success_score INTEGER NOT NULL CHECK (success_score >= 0 AND success_score <= 100),
  outcome_variance_plain TEXT NOT NULL,
  confidence_delta_plain TEXT NOT NULL,
  replication_score TEXT NOT NULL CHECK (replication_score IN ('LOW', 'MEDIUM', 'HIGH', 'UNKNOWN')),
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outcomes_organization_id ON outcomes(organization_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_objective_id ON outcomes(objective_id);

CREATE TABLE IF NOT EXISTS connectors (
  connector_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  connector_class TEXT NOT NULL CHECK (connector_class IN ('COMMUNICATION', 'SCHEDULING', 'REVENUE', 'DEVELOPMENT', 'BUSINESS', 'CUSTOM')),
  can_read INTEGER NOT NULL DEFAULT 0 CHECK (can_read IN (0, 1)),
  can_recommend INTEGER NOT NULL DEFAULT 0 CHECK (can_recommend IN (0, 1)),
  can_execute INTEGER NOT NULL DEFAULT 0 CHECK (can_execute IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('CONNECTED', 'DEGRADED', 'DISCONNECTED', 'AWAITING_PERMISSION')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connectors_organization_id ON connectors(organization_id);

CREATE TABLE IF NOT EXISTS founder_reviews (
  review_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id) ON DELETE CASCADE,
  requested_by_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  request_plain TEXT NOT NULL,
  customer_facing_status_plain TEXT NOT NULL,
  kingmaker_internal_status_plain TEXT NOT NULL,
  recommended_decision_plain TEXT,
  status TEXT NOT NULL CHECK (status IN ('PARKED', 'QUEUED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'APPEALED', 'CLOSED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_founder_reviews_organization_id ON founder_reviews(organization_id);
CREATE INDEX IF NOT EXISTS idx_founder_reviews_status ON founder_reviews(status);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  public_summary_plain TEXT NOT NULL,
  internal_summary_plain TEXT NOT NULL,
  decision_plain TEXT,
  reason_plain TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_subject ON audit_events(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_id ON audit_events(actor_id);

CREATE TABLE IF NOT EXISTS vocal_interaction_profiles (
  profile_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  current_mode TEXT NOT NULL CHECK (current_mode IN ('PROFESSIONAL', 'CONCISE', 'ANALYST', 'TEACHING', 'ROGUE', 'CALM')),
  default_mode TEXT NOT NULL CHECK (default_mode IN ('PROFESSIONAL', 'CONCISE', 'ANALYST', 'TEACHING', 'ROGUE', 'CALM')),
  last_tonality_signal TEXT NOT NULL CHECK (last_tonality_signal IN ('NEUTRAL', 'TIRED', 'FRUSTRATED', 'URGENT', 'CONFUSED', 'DIRECT_REQUESTED', 'UNKNOWN')),
  explicit_user_preference_plain TEXT,
  notes_plain TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vocal_profiles_user_id ON vocal_interaction_profiles(user_id);
