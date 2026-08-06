#!/bin/bash

find . -type f -name "config.json" | while read -r file; do
    tmp=$(mktemp)

    jq '
    def fix:
      if type == "object" then
        if .id? == "backgroundColor" and (.alpha | not) then
          . + { alpha: true }
        else
          with_entries(.value |= fix)
        end
      elif type == "array" then
        map(fix)
      else
        .
      end;

    fix
    ' "$file" > "$tmp"

    if ! cmp -s "$file" "$tmp"; then
        mv "$tmp" "$file"
        echo "Updated: $file"
    else
        rm "$tmp"
    fi
done

echo "Done."