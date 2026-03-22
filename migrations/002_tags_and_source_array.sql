-- migrations/002_tags_and_source_array.sql
-- Convert source from varchar to text[] and add tags across all tiers

-- Captures: source varchar → text[], add tags
ALTER TABLE captures ALTER COLUMN source TYPE text[] USING ARRAY[source];
ALTER TABLE captures ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_captures_tags ON captures USING GIN (tags);
CREATE INDEX idx_captures_source ON captures USING GIN (source);

-- Facts: drop category, add tags and source
ALTER TABLE facts DROP COLUMN category;
ALTER TABLE facts ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE facts ADD COLUMN source text[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_facts_tags ON facts USING GIN (tags);
CREATE INDEX idx_facts_source ON facts USING GIN (source);

-- Insights: drop category, add tags and source
ALTER TABLE insights DROP COLUMN category;
ALTER TABLE insights ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE insights ADD COLUMN source text[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_insights_tags ON insights USING GIN (tags);
CREATE INDEX idx_insights_source ON insights USING GIN (source);
