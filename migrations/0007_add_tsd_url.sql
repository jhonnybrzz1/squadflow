-- Migration: Add tsd_url column to demands table
-- TSD (Technical Specification Document) is generated separately from PRD for technical demands

ALTER TABLE demands ADD COLUMN tsd_url TEXT;
