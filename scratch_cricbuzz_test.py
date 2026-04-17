import requests
from bs4 import BeautifulSoup
import re

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36'
}

url = "https://www.cricbuzz.com/live-cricket-scores/151796/gt-vs-kkr-25th-match-indian-premier-league-2026"
r2 = requests.get(url, headers=headers)
s2 = BeautifulSoup(r2.text, 'lxml')
pageText = s2.get_text()

m = re.search(r'(\d+)/(\d+)(?:\s*\(([\d.]+)\s*(?:ov)?\))?', pageText)
if m:
    print("  Score match:", m.group(0))
else:
    print("  No score match")
