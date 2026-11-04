#!/bin/sh
# Status-line tap: reads Claude Code's stdin payload, records the account's rate limits under
# ${XDG_STATE_HOME:-$HOME/.local/state}/herdr-tower/usage/, then runs the original status line
# command with the same stdin. Prints nothing itself and never fails the status line: any error
# path just runs the original command.

[ $# -gt 0 ] || exit 0

dir="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-tower/usage"
tmp=$(mktemp "${TMPDIR:-/tmp}/herdr-usage.XXXXXX" 2>/dev/null) || exec "$@"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" 2>/dev/null || { rm -f "$tmp"; exec "$@"; }

# Only $HOME/.claude and $HOME/.claude-accounts/<name> name an account; any other
# CLAUDE_CONFIG_DIR records nothing, so one dir's usage never lands in another's file.
cfg=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
cfg=${cfg%/}
account=
case "$cfg" in
  "$HOME/.claude") account=default ;;
  "$HOME"/.claude-accounts/?*)
    b=${cfg#"$HOME"/.claude-accounts/}
    case "$b" in ''|*[!A-Za-z0-9_-]*) account= ;; *) account=$b ;; esac ;;
esac

# No node, or no account for this config dir: leave the file alone and run the status line.
if [ -n "$account" ] && command -v node >/dev/null 2>&1; then
  node -e 'const fs=require("fs"),path=require("path");const a=process.argv.slice(1),payload=a[0],out=a[1];const quit=()=>process.exit(0);let p;try{p=JSON.parse(fs.readFileSync(payload,"utf8"))}catch{quit()}const lim=p&&p.rate_limits;if(!lim||typeof lim!=="object")quit();const win=(w)=>w&&typeof w.used_percentage==="number"?{used:w.used_percentage,resets_at:typeof w.resets_at==="number"?w.resets_at:null}:null;const fresh={five_hour:win(lim.five_hour),seven_day:win(lim.seven_day)};let rec={};try{rec=JSON.parse(fs.readFileSync(out,"utf8"))||{}}catch{}const newer=(o,n)=>{if(!o||o.resets_at==null||n.resets_at==null)return true;const g=n.resets_at-o.resets_at;if(g>3600)return true;if(g<-3600)return false;return n.used>=o.used};const merged={};let changed=false;for(const k of ["five_hour","seven_day"]){const o=rec[k],n=fresh[k];if(n&&newer(o,n)){merged[k]=n;changed=true}else if(o){merged[k]=o}}if(!changed)quit();merged.updated_at=Math.floor(Date.now()/1000);fs.mkdirSync(path.dirname(out),{recursive:true});const t=out+".tmp."+process.pid;try{fs.writeFileSync(t,JSON.stringify(merged));fs.renameSync(t,out)}catch{try{fs.unlinkSync(t)}catch{}}' \
    "$tmp" "$dir/$account.json" >/dev/null 2>&1 || :
fi

exec 3< "$tmp" || { rm -f "$tmp"; exec "$@"; }
rm -f "$tmp"
exec "$@" <&3 3<&-
