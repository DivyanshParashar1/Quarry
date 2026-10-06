# Ashby fixtures

`example-board.json` is **synthetic**: it follows the documented shape of
Ashby's public posting API (`GET https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true`)
because the build sandbox had no network route to api.ashbyhq.com. Re-record it
from a real board when possible and adjust the plugin if any field differs:

```sh
curl -s 'https://api.ashbyhq.com/posting-api/job-board/<board>?includeCompensation=true' \
  | jq '.jobs |= .[:6]' > plugins/source-ashby/fixtures/<board>-board.json
```

`not-found.json` is the body used for a 404 (unknown board).
