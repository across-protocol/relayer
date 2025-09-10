This repo adpots [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) for the sake of consistency and clarity of code.

In addition to the style guide above, the following principles should be followed:
- functions should be short, < 100 LOC
- files should be short, < 1000 LOC
- functions should rarely have more than a couple of indentations within them, e.g. max 3. If there's more, it's usually a sign that functionality can be extracted to a separate function with readable name
- within the same file / class, there should be minimal redundancy
- comment line length should not exceed the configured max code line length: 120 characters
