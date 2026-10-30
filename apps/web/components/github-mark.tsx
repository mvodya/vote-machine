// Use the same supplied brand icon wherever the repository is linked
export function GithubMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-4 shrink-0 bg-current [mask:url(/brand/github.svg)_center/contain_no-repeat]"
    />
  );
}
