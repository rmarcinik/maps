from livereload import Server

s = Server()
s.watch('style.json')
s.watch('index.html')
s.watch('sw.js')
s.serve(port=8080)
