#!/bin/bash
# Script wrapper to run PRD validation in CI
# Fails only if a PRD file is part of the PR/commit changes.

npx tsx scripts/validate-prds.ts
VALIDATE_EXIT=$?

npx tsx scripts/compat-prds.ts
COMPAT_EXIT=$?

if [ $VALIDATE_EXIT -ne 0 ] || [ $COMPAT_EXIT -ne 0 ]; then
  # Check if any PRD or markdown file was changed in this commit/PR
  # GitHub Actions typically provides github.event.pull_request.base.sha or similar
  # For simplicity, we check if there are markdown files changed in recent commits
  
  # Fetch git diff (this works differently based on whether it's a PR or push)
  # But assuming we just warn instead of failing if not PRD-related
  
  echo "⚠️ Warning: PRD Validation or Compatibility check failed."
  
  CHANGED_PRDS=$(git diff --name-only HEAD~1 HEAD | grep 'documents/PRD_')
  
  if [ -n "$CHANGED_PRDS" ]; then
    echo "❌ Error: You modified PRD files in this commit and introduced PRD errors."
    exit 1
  else
    echo "⚠️ Warning: PRD errors exist, but you didn't modify PRDs. Treating as non-fatal."
    exit 0
  fi
else
  echo "✅ PRD Validation and Compatibility checks passed."
  exit 0
fi
