#!/bin/bash
# Test image generation via /v1/responses
# Usage: ./test-image-gen.sh [prompt] [size]
# Requires: ChatGPT Plus or higher account for actual image generation

PROXY_URL="${PROXY_URL:-http://localhost:9180}"
API_KEY="${API_KEY:-sk-331c7069bcbeae08-x1cfyv-9de50609}"
PROMPT="${1:-Draw a red circle on a white background}"
SIZE="${2:-1024x1024}"
OUTPUT_FILE="generated_image_$(date +%s).png"
TMPFILE=$(mktemp)

echo "=== Image Generation Test ==="
echo "Prompt: $PROMPT"
echo "Size: $SIZE"
echo "Waiting for response..."
echo ""

curl -s --max-time 120 -N "$PROXY_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"gpt-5.5\",
    \"stream\": true,
    \"input\": [{\"role\":\"user\",\"content\":\"$PROMPT\"}],
    \"tools\": [{\"type\":\"image_generation\",\"size\":\"$SIZE\"}]
  }" > "$TMPFILE" 2>/dev/null

EVENTS=$(grep "^event:" "$TMPFILE")
echo "Events received:"
echo "$EVENTS"
echo ""

# Check if image generation actually happened
if echo "$EVENTS" | grep -q "image_generation_call"; then
  echo "[🎨] Image generation detected!"

  # Try partial_image_b64 (last one is the final image)
  IMAGE_LINE=$(grep "partial_image_b64" "$TMPFILE" | tail -1)
  if [ -n "$IMAGE_LINE" ]; then
    IMAGE_B64=$(echo "$IMAGE_LINE" | sed 's/^data: //' | jq -r '.partial_image_b64')
  fi

  # Fallback: try .result from completed event
  if [ -z "$IMAGE_B64" ] || [ "$IMAGE_B64" = "null" ]; then
    IMAGE_LINE=$(grep "image_generation_call.completed" "$TMPFILE" | tail -1)
    if [ -n "$IMAGE_LINE" ]; then
      IMAGE_B64=$(echo "$IMAGE_LINE" | sed 's/^data: //' | jq -r '.result')
    fi
  fi

  if [ -n "$IMAGE_B64" ] && [ "$IMAGE_B64" != "null" ]; then
    printf '%s' "$IMAGE_B64" | base64 -d > "$OUTPUT_FILE"
    FILESIZE=$(wc -c < "$OUTPUT_FILE" | tr -d ' ')
    echo "[✅] Image saved: $OUTPUT_FILE ($FILESIZE bytes)"
  else
    echo "[❌] Image event found but no image data extracted"
  fi

  # Revised prompt
  REVISED=$(grep "revised_prompt" "$TMPFILE" | tail -1 | sed 's/^data: //' | jq -r '.revised_prompt // empty' 2>/dev/null)
  [ -n "$REVISED" ] && echo "[📝] Revised: $REVISED"
else
  echo "[⚠️] No image generation — account likely Free tier (Plus+ required)"
  echo "    Model returned text instead:"
  grep -A1 "event: response.output_text.done" "$TMPFILE" | grep "^data:" | sed 's/^data: //' | jq -r '.text // empty' 2>/dev/null
fi

rm -f "$TMPFILE"
