import urllib.request
try:
    res = urllib.request.urlopen("https://extended-essay-model-c204fj9n5-shreyas-projects-efe5af02.vercel.app/api/live")
    print("STATUS:", res.getcode())
    print("BODY:", res.read().decode())
except urllib.error.HTTPError as e:
    print("HTTP ERROR:", e.code)
    print("BODY:", e.read().decode())
