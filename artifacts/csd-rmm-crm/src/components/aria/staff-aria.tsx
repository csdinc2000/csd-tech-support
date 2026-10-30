import AriaWidget from "./aria-widget";

/** In flow on phones so the staff page remains usable while chat is expanded. */
export default function StaffAria() {
  return (
    <div className="flex justify-end p-4 sm:contents">
      <AriaWidget />
    </div>
  );
}