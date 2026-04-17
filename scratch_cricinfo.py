import urllib.request
import re

urls = {
  'GT': 'https://www.espncricinfo.com/team/gujarat-titans-1296711',
  'LSG': 'https://www.espncricinfo.com/team/lucknow-super-giants-1296709',
  'PBKS': 'https://www.espncricinfo.com/team/punjab-kings-335973',
  'KKR': 'https://www.espncricinfo.com/team/kolkata-knight-riders-335971',
  'MI': 'https://www.espncricinfo.com/team/mumbai-indians-335978'
}
for name, u in urls.items():
    try:
        req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
        res = urllib.request.urlopen(req).read().decode()
        m = re.search(r'https://img1\.hscicdn\.com/image/upload/[^"]*\.png', res)
        if m:
            print(name + ": " + m.group(0))
        else:
            print(name + ": " + "Not found")
    except Exception as e:
        print(f"Error {name}: {e}")
