PYTHON ?= python3
BIND ?= 127.0.0.1
SINGLE_PORT ?= 8069
MULTIPLAYER_PORT ?= 8070
DELIVERY_URL ?= http://127.0.0.1:$(MULTIPLAYER_PORT)/

.PHONY: help build lint lint-js lint-python lint-shell lint-whitespace \
	test test-unit test-engine test-leaderboard test-release test-multiplayer \
	test-browser test-browser-single test-browser-multiplayer test-delivery test-container \
	serve-single serve-multiplayer validate validate-single validate-multiplayer

help: ## List development commands
	@awk 'BEGIN { FS = ":.*## "; print "Scorched Earth development targets:" } /^[a-z-]+:.*## / { printf "  %-26s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: ## Bundle the game into dist/index.html
	npm run build

lint: lint-js lint-python lint-shell lint-whitespace ## Check source syntax and trailing whitespace

lint-js: ## Parse JavaScript with Node
	@find src server scripts tests tools -type f \( -name '*.js' -o -name '*.mjs' \) \
		-exec sh -ec 'for file do node --check "$$file"; done' sh {} +

lint-python: ## Parse Python without writing bytecode
	@find blender models tests tools -type f -name '*.py' \
		-exec "$(PYTHON)" -c 'from pathlib import Path; import sys; paths = map(Path, sys.argv[1:]); [compile(p.read_bytes(), str(p), "exec") for p in paths]' {} +

lint-shell: ## Parse Bash scripts
	@find scripts -type f -name '*.sh' \
		-exec sh -ec 'for file do bash -n "$$file"; done' sh {} +

lint-whitespace: ## Report trailing spaces and tabs in source files
	@find src server scripts tests tools blender models -type f \
		\( -name '*.js' -o -name '*.mjs' -o -name '*.py' -o -name '*.sh' -o -name '*.html' -o -name '*.css' \) \
		-exec awk '/[ \t]$$/ { printf "%s:%d: trailing whitespace\n", FILENAME, FNR; bad = 1 } END { exit bad }' {} +

test: test-unit test-multiplayer ## Run unit and multiplayer protocol tests

test-unit: test-engine test-leaderboard test-release ## Run engine, leaderboard, and release tests

test-engine: ## Run engine, physics, and AI tests
	npm run test:engine

test-leaderboard: ## Run leaderboard ranking and persistence tests
	node --test tests/leaderboard.test.js

test-release: ## Run SemVer and container-tag tests
	npm run test:release

test-multiplayer: build ## Run the multiplayer protocol suite with its own server
	npm run test:multiplayer

test-browser: test-browser-single test-browser-multiplayer ## Run both Playwright browser suites

test-browser-single: build ## Run the offline local-battle browser smoke test
	"$(PYTHON)" tests/browser_check.py

test-browser-multiplayer: build ## Run a two-browser online match with its own server
	"$(PYTHON)" tests/multiplayer_browser.py

test-delivery: build ## Check an already-running multiplayer server at DELIVERY_URL
	npm run test:delivery -- "$(DELIVERY_URL)"

test-container: build ## Check a locally built Docker image and its deployment
	npm run test:container

serve-single: build ## Serve the bundle over HTTP for local battles (port 8069)
	"$(PYTHON)" -m http.server "$(SINGLE_PORT)" --bind "$(BIND)" --directory dist

serve-multiplayer: build ## Run the HTTP and WebSocket game server (port 8070)
	HOST="$(BIND)" PORT="$(MULTIPLAYER_PORT)" node server/server.js

validate-single: test-engine test-leaderboard test-browser-single ## Validate local battles

validate-multiplayer: test-multiplayer test-browser-multiplayer ## Validate online battles

validate: lint test test-browser ## Run lint, unit, protocol, and browser checks
