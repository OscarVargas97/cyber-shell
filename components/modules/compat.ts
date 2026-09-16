// Reemplazo minimo de la vieja "Variable" de astal (ya no existe en ags
// v3.1 - fue reemplazada por Accessor/createPoll de gnim). El uso real en
// este repo es siempre como caja mutable con get()/set(), sin bindings
// reactivos, asi que no hace falta portar al sistema nuevo. Se llama sin
// "new" en todo el codigo original (Variable(0)), por eso es una factory
// function y no una clase.
export function Variable<T>(init: T) {
    let v = init
    const subs = new Set<(v: T) => void>()
    return {
        get(): T { return v },
        set(next: T) { v = next; for (const cb of subs) cb(v) },
        subscribe(cb: (v: T) => void) { subs.add(cb); return () => subs.delete(cb) },
    }
}
