#!/usr/bin/env bash

OUTPUT="project_dump.txt"
> "$OUTPUT"

find . -type f ! -name "$OUTPUT" | sort | while read -r file; do
    echo "==================================================" >> "$OUTPUT"
    echo "FILE: $file" >> "$OUTPUT"

    if grep -Iq . "$file"; then
        echo "TYPE: TEXT" >> "$OUTPUT"
        cat "$file" >> "$OUTPUT"
    else
        echo "TYPE: BINARY (BASE64)" >> "$OUTPUT"
        base64 -w 0 "$file" >> "$OUTPUT" 2>/dev/null || base64 "$file" >> "$OUTPUT"
        echo >> "$OUTPUT"
    fi

    echo >> "$OUTPUT"
done