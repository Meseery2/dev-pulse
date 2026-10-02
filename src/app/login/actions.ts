"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { verifyCredentials } from "@/lib/auth/accounts";
import { createSessionToken, setSessionCookie } from "@/lib/auth/session";
import { landingPathFor } from "@/lib/auth/guard";

const schema = z.object({
  username: z.string().trim().min(1, "Enter your username"),
  password: z.string().min(1, "Enter your password"),
});

export interface LoginState {
  error?: string;
}

export async function login(_state: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({
    username: formData.get("username"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter your username and password" };
  }

  const user = await verifyCredentials(parsed.data.username, parsed.data.password);
  // The same message is returned for an unknown user and a wrong password so
  // the form cannot be used to enumerate accounts.
  if (!user) return { error: "Those credentials were not recognised" };

  await setSessionCookie(await createSessionToken(user));
  redirect(landingPathFor(user));
}
