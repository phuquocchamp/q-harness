
## Bash Command
```bash
for f in \
  README.md \
  TODOS.md \
  .claude-plugin/marketplace.json \
  plugins/q-panel/.claude-plugin/plugin.json \
  plugins/q-panel/hooks/hooks.json \
  plugins/q-panel/hooks/register.tsx \
  plugins/q-panel/hooks/lib/*.ts \
  plugins/q-panel/tests/bash-panel.test.ts \
  plugins/q-panel/tests/code-blocks.test.ts \
  plugins/q-panel/types/index.d.ts
do
  echo "===== $f"
  cat "$f"
done
```
