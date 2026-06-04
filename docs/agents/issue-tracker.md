# Issue Tracker

**Type**: GitHub  
**Repository**: `peaches-nine/CloudCabin`

## Commands

```bash
# List open issues
gh issue list --repo peaches-nine/CloudCabin

# Create an issue
gh issue create --repo peaches-nine/CloudCabin --title "…" --body "…"

# View an issue
gh issue view <N> --repo peaches-nine/CloudCabin

# Add labels
gh issue edit <N> --repo peaches-nine/CloudCabin --add-label "needs-triage"
```

## Workflow

1. When reading issues, use `issue://<N>` URIs
2. When creating issues, use the `gh` CLI as above
3. Issue creation requires the `gh` CLI to be authenticated with `peaches-nine` GH account
