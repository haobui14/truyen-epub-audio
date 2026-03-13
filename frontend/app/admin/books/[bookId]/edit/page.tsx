import EditBookClient from "./EditBookClient";

export function generateStaticParams() {
  return [{ bookId: "placeholder" }];
}

export default function Page() {
  return <EditBookClient />;
}
