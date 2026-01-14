// This file intentionally contains lint errors for testing.

// Error: no-unused-vars (severity 2) - unused variable
const unusedVariable = 42;

// Error: no-unused-vars (severity 2) - unused function
function unusedFunction() {
  return "never called";
}

// Warning: no-console (severity 1) - should not appear in findings
console.log("This is a warning, not an error");

// Another unused variable for multiple errors
const anotherUnused = "test";
