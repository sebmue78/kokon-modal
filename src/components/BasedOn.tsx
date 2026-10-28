import { native } from "../lib/native";
import { UPSTREAM_AUTHOR, UPSTREAM_REPO_URL } from "../lib/fork";
import { toastError } from "../lib/store";

/** Fork: "Based on Kokon by …", linking the original repository. On the welcome and setup
 * screens and in Settings. */
export function BasedOnKokon(props: { className?: string }) {
  return (
    <span className={`based-on ${props.className ?? ""}`}>
      Based on{" "}
      <a
        href={UPSTREAM_REPO_URL}
        onClick={(e) => {
          e.preventDefault();
          native.openLink(UPSTREAM_REPO_URL).catch(toastError);
        }}
      >
        Kokon
      </a>{" "}
      by {UPSTREAM_AUTHOR} · github.com/GabrieleLozupone/kokon
    </span>
  );
}
