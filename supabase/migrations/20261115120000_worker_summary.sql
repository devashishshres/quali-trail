-- Optional technician-authored career summary, shown on the Passport and the
-- qualification packet. Additive: nullable, no default, no data rewrite.
-- Existing rows, saved match runs and clients that do not know the column keep
-- working. It is displayed as the worker's own words, never as verified fact.
--
-- Write path: trusted server code or the seed script (service role). No client
-- UPDATE grant is added, so workers cannot bypass validation through the
-- publishable key.
alter table public.workers
  add column if not exists summary text
  check (summary is null or char_length(summary) between 1 and 1000);
