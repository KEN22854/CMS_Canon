export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-semibold text-primary">404</p>
      <h1 className="mt-2 text-3xl font-bold">Page not found</h1>
      <p className="mt-4 opacity-70">The page you are looking for does not exist or is no longer published.</p>
      <a href="/" className="mt-8 rounded-site bg-primary px-5 py-2.5 font-semibold text-white">Go to the home page</a>
    </main>
  );
}
