/**
 * 031: Community KYC + membership rules
 *
 * Gates community creation behind a manual KYC review and adds whitelist /
 * pattern-matching rules so a community can auto-admit users by email domain
 * (or queue them for admin approval) in addition to the existing invite-link
 * flow.
 *
 * - community_kyc_submissions: per-user identity submission. Manual review
 *   for now (no Persona/Onfido). status: pending|approved|rejected.
 * - group_membership_rules: per-community auto-join rules. rule_type today
 *   is email_domain (the practical interpretation of "org id"), but the
 *   column is open so email_pattern / org_id rule types can land later.
 * - group_join_requests: when a rule matches with auto_approve=false (or no
 *   rule matches and the community accepts requests), the user lands here
 *   for the community admin to decide.
 * - users.is_platform_admin: gates the KYC review queue. There is no admin
 *   bootstrap UI — the first admin must be flipped manually in the DB.
 * - users.org_domain: denormalized from the email at signup, indexed so
 *   discovery (find communities I'm eligible for) is one indexed lookup.
 * - groups.kyc_submission_id: ties a community back to the KYC that
 *   authorized its creation, so revoking a KYC can also disable the group.
 */

const up = async (client) => {
  console.log('Running migration 031: community KYC + membership rules...');

  await client.query(`
    CREATE TABLE IF NOT EXISTS community_kyc_submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected')),
      full_legal_name TEXT NOT NULL,
      org_name TEXT NOT NULL,
      org_email TEXT NOT NULL,
      org_domain TEXT NOT NULL,
      org_role TEXT,
      id_document_url TEXT,
      proof_of_org_url TEXT,
      notes TEXT,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      rejection_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_kyc_user ON community_kyc_submissions(user_id);
    CREATE INDEX IF NOT EXISTS idx_kyc_status_submitted ON community_kyc_submissions(status, submitted_at);
  `);

  // One pending or approved submission per user — they can re-submit only after rejection.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_kyc_active_per_user
      ON community_kyc_submissions(user_id)
      WHERE status IN ('pending','approved');
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS group_membership_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      rule_type VARCHAR(20) NOT NULL DEFAULT 'email_domain'
        CHECK (rule_type IN ('email_domain','email_pattern','org_id')),
      pattern TEXT NOT NULL,
      auto_approve BOOLEAN NOT NULL DEFAULT true,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rules_group ON group_membership_rules(group_id);
    CREATE INDEX IF NOT EXISTS idx_rules_type_pattern ON group_membership_rules(rule_type, pattern);
  `);

  // No duplicate rule for the same (group, type, pattern).
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_rule_per_group
      ON group_membership_rules(group_id, rule_type, pattern);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS group_join_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected')),
      matched_rule_id UUID REFERENCES group_membership_rules(id) ON DELETE SET NULL,
      message TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ,
      decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE (group_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_join_req_group_status ON group_join_requests(group_id, status);
    CREATE INDEX IF NOT EXISTS idx_join_req_user ON group_join_requests(user_id);
  `);

  await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS org_domain TEXT;
  `);

  await client.query(`
    UPDATE users
       SET org_domain = LOWER(SPLIT_PART(email, '@', 2))
     WHERE org_domain IS NULL AND email IS NOT NULL;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_users_org_domain ON users(org_domain);
  `);

  await client.query(`
    ALTER TABLE groups
      ADD COLUMN IF NOT EXISTS kyc_submission_id UUID
        REFERENCES community_kyc_submissions(id) ON DELETE SET NULL;
  `);

  console.log('Migration 031 complete.');
};

const down = async (client) => {
  await client.query(`
    ALTER TABLE groups DROP COLUMN IF EXISTS kyc_submission_id;
    DROP INDEX IF EXISTS idx_users_org_domain;
    ALTER TABLE users
      DROP COLUMN IF EXISTS org_domain,
      DROP COLUMN IF EXISTS is_platform_admin;
    DROP TABLE IF EXISTS group_join_requests CASCADE;
    DROP TABLE IF EXISTS group_membership_rules CASCADE;
    DROP TABLE IF EXISTS community_kyc_submissions CASCADE;
  `);
};

module.exports = { up, down };
