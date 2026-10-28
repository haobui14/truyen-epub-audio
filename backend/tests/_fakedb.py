"""Minimal stand-in for the supabase-py query builder used by router tests.

handlers maps (table, op) -> fn(query) returning the `data` of the result.
Every execute() is recorded in `calls` as (table, op, filters, payload).
"""
from types import SimpleNamespace


class FakeQuery:
    def __init__(self, db, table):
        self.db = db
        self.table = table
        self.op = "select"
        self.columns = None
        self.filters = {}
        self.payload = None

    def select(self, columns="*", **_kwargs):
        self.columns = columns
        return self

    def insert(self, payload, **_kwargs):
        self.op, self.payload = "insert", payload
        return self

    def upsert(self, payload, **_kwargs):
        self.op, self.payload = "upsert", payload
        return self

    def update(self, payload, **_kwargs):
        self.op, self.payload = "update", payload
        return self

    def delete(self, **_kwargs):
        self.op = "delete"
        return self

    def eq(self, column, value):
        self.filters[column] = value
        return self

    def lt(self, column, value):
        self.filters[f"{column}<"] = value
        return self

    def order(self, *_args, **_kwargs):
        return self

    def range(self, start, end):
        self.filters["range"] = (start, end)
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def maybe_single(self):
        return self

    def execute(self):
        self.db.calls.append((self.table, self.op, dict(self.filters), self.payload))
        handler = self.db.handlers.get((self.table, self.op))
        data = handler(self) if handler else None
        return SimpleNamespace(data=data)


class FakeDb:
    def __init__(self, handlers=None):
        self.handlers = dict(handlers or {})
        self.calls = []

    def table(self, name):
        return FakeQuery(self, name)

    def count(self, table, op):
        return sum(1 for t, o, _f, _p in self.calls if t == table and o == op)
