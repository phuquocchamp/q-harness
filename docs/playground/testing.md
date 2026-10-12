
## Bash Command
```bash
for f in \
  .claude/settings.json \
  README.md \
  TODOS.md \
  .claude-plugin/marketplace.json \
  plugins/q-bash/.claude-plugin/plugin.json \
  plugins/q-bash/hooks/hooks.json \
  plugins/q-bash/hooks/register.tsx \
  plugins/q-bash/tests/bash-panel.test.ts \
  plugins/q-bash/types/index.d.ts
do
  echo "===== $f"
  cat "$f"
done
```
