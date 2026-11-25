import { redirect } from "next/navigation";

/** Compatibility URL: the task center lives at /tasks. */
export default function Page() {
    redirect("/tasks");
}
