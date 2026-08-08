# Sources & attribution

## Upstream inspiration

**baidu-drive** skill from Baidu Netdisk / community packaging:

- Repository: https://github.com/baidu-netdisk/bdpan-storage  
- Skill path: `skills/baidu-drive/`  
- Install: `npx skills add https://github.com/baidu-netdisk/bdpan-storage/skills --skill baidu-drive`  
- Reviewed version: **v1.7.3** (local clone at absorb time)

### Absorbed (patterns only)

- Explicit TRIGGER / DO NOT TRIGGER / conversation continuity  
- Risk-tier confirmation matrix + ambiguity / cancel rules  
- First-use safety notes (backup, human review, no token leakage)  
- Ordered preflight before operations  
- Verify-before-write (exists/list then mutate)  
- Dialogue-style examples and error→user-message tables  
- Progress reporting for long-running jobs  

### Not absorbed (different product)

- `bdpan` OpenAPI CLI and `/apps/bdpan` path jail  
- OAuth `login.sh` / token file handling  
- Upload / download / transfer / share command flows  
- Agent memory backup scripts  

## This skill’s own stack

Chrome MV3 extension + Python bridge originally developed for local pan automation; packaged under this skill’s `extension/` and `tools/`.
