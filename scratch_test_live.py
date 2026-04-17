from app import app

with app.test_request_context():
    from app import api_live
    res = api_live()
    print(res.get_data(as_text=True))
