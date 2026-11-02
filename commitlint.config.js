// Conventional Commits; тема коммита может быть на русском — регистр не ограничиваем.
export default {
  extends: ["@commitlint/config-conventional"],
  // Слияния веток («Слияние: …», «Merge …») допустимы в свободной форме.
  ignores: [(msg) => /^(Слияние|Merge)[ :]/u.test(msg)],
  rules: {
    "subject-case": [0],
    "body-max-line-length": [0],
  },
};
