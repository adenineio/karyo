A composition root that builds every part once and hands handlers a typed container (`Services`), whose
attributes are typed with the parts' classes. The handlers import only the container's module, never the parts:
the calls they make through it (`services.orders.place(…)`) are real, and the import check must not call them
"no-import" (tests/imports.test.ts).
