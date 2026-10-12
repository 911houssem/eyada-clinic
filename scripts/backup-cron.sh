#!/bin/sh
# External backup: tars the whole DATA_DIR (db.json + files/ + sessions) and
# optionally ships it to remote storage. Run from cron, e.g.:
#   0 3 * * * /opt/eyada-clinic/scripts/backup-cron.sh >> /var/log/eyada-backup.log 2>&1
set -eu
APP_DIR="${APP_DIR:-/opt/eyada-clinic}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
OUT_DIR="${BACKUP_OUT_DIR:-$APP_DIR/backups-external}"
REMOTE="${BACKUP_REMOTE:-}"   # e.g. "user@host:/backups/eyada" (scp) — empty = local only
KEEP="${BACKUP_KEEP_DAYS:-30}"

mkdir -p "$OUT_DIR"
TS="$(date +%F-%H%M)"
DEST="$OUT_DIR/eyada-data-$TS.tar.gz"
tar -czf "$DEST" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
echo "wrote $DEST ($(du -h "$DEST" | cut -f1))"
find "$OUT_DIR" -name 'eyada-data-*.tar.gz' -mtime +"$KEEP" -delete
if [ -n "$REMOTE" ]; then
  scp "$DEST" "$REMOTE/" && echo "uploaded to $REMOTE"
fi
echo "done"
