import requests
from bs4 import BeautifulSoup
import re

BASE_URL = "https://www.cricbuzz.com"
LIVE_URL = f"{BASE_URL}/cricket-match/live-scores"
headers = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Referer": BASE_URL,
}
response = requests.get(LIVE_URL, headers=headers, timeout=15)
soup = BeautifulSoup(response.text, "lxml")

for d in soup.find_all('div', class_='cb-mtch-lst'):
    print("MATCH:", d.get_text(separator=' | '))

print("\n--- NEW CONTAINER TRY ---")
for d in soup.find_all('div', class_=lambda x: x and 'bg-[#444]' in x):
    print("CONTAINER:", d.get_text())

