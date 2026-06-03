import Link from 'next/link';

export default function EventNotFound() {
  return (
    <div className="space-y-4 py-12 text-center">
      <h1 className="text-2xl font-bold">Event not found</h1>
      <p className="text-muted-foreground">
        It may have been deleted, or the URL is wrong.
      </p>
      <Link href="/events" className="underline">
        Back to sync feed
      </Link>
    </div>
  );
}
