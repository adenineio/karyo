from shop.app import serve

assert serve("/orders/tea") == 3
assert serve("/cancel/1") is True
