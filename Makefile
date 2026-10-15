.PHONY: build check test

build:
	npx tsc -p tsconfig.build.json

check:
	npx tsc --noEmit

test:
	node --experimental-strip-types --test tests/*.ts tests/parser/*.ts
