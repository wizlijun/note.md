-- Sender filtering is a persistent user-controlled policy. The legacy expiry
-- column remains for schema compatibility but is no longer read by the Worker.
UPDATE intake_policy
SET setup_expires_at = NULL
WHERE singleton = 1;
