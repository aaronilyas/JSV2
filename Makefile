.PHONY: build check test wasm

build:
	npx tsc -p tsconfig.build.json

check:
	npx tsc --noEmit

wasm:
	mkdir -p runtime/wasm
	cd runtime/go && GOOS=js GOARCH=wasm go build -o ../../runtime/wasm/jsv.wasm .
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" runtime/wasm/wasm_exec.js

test: wasm
	cd runtime/go && go test ./...
	node --experimental-strip-types --test tests/*.ts tests/parser/*.ts tests/checker/*.ts tests/runtime/*.ts tests/mcp/*.ts
