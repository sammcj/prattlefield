.PHONY: install dev build lint test run clean

install:
	npm install

dev: run

run:
	# Call vite directly: npm swallows Ctrl+C and can orphan the dev server.
	./node_modules/.bin/vite

build:
	npm run build

lint:
	npm run typecheck

test:
	npm run test

clean:
	rm -rf dist node_modules
